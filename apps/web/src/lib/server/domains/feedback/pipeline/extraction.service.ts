/**
 * Pass 1: Signal extraction service.
 *
 * Calls LLM to extract feedback signals from a raw item.
 * Idempotent: clears existing signals before creating new ones.
 */

import { UnrecoverableError } from 'bullmq'
import { chat } from '@tanstack/ai'
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible'
import { z } from 'zod'
import type { ChatMiddleware } from '@tanstack/ai'
import { db, eq, rawFeedbackItems, feedbackSignals, sql } from '@/lib/server/db'
import { config } from '@/lib/server/config'
import {
  isAiClientConfigured,
  structuredOutputProviderOptions,
} from '@/lib/server/domains/ai/config'
import { createUsageLoggingMiddleware } from '@/lib/server/domains/ai/usage-middleware'
import { getChatModel } from '@/lib/server/domains/ai/models'
import { buildExtractionPrompt } from './prompts/extraction.prompt'
import { shouldExtract } from './quality-gate.service'
import { logPipelineEvent } from './pipeline-log'
import { enqueueFeedbackAiJob } from '../queues/feedback-ai-queue'
import { logger } from '@/lib/server/logger'
import type { RawFeedbackContent, RawFeedbackItemContextEnvelope } from '../types'
import type { RawFeedbackItemId } from '@quackback/ids'

const log = logger.child({ component: 'extraction' })

const EXTRACTION_PROMPT_VERSION = 'v1'

// Mirrors the extraction prompt's contract (prompts/extraction.prompt.ts).
// Kept permissive on the per-signal fields the old hand-parsed path never
// actually validated (signalType as a free string, confidence optional,
// evidence defaulted) — chat()'s outputSchema now enforces the top-level
// `signals` array where the old code threw UnrecoverableError by hand
// ('Extraction result missing signals array'), but stays exactly as
// tolerant as before for the per-signal shape so a borderline model
// response doesn't newly hard-fail where it used to succeed.
const ExtractionSignalSchema = z.object({
  signalType: z.string(),
  summary: z.string(),
  implicitNeed: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  confidence: z.number().optional(),
})

const ExtractionResultSchema = z.object({
  signals: z.array(ExtractionSignalSchema),
})

/**
 * Extract signals from a raw feedback item.
 * Called by the {feedback-ai} queue worker.
 */
export async function extractSignals(
  rawItemId: RawFeedbackItemId,
  attemptContext?: { currentAttempt: number; maxAttempts: number }
): Promise<void> {
  const item = await db.query.rawFeedbackItems.findFirst({
    where: eq(rawFeedbackItems.id, rawItemId),
  })

  if (!item) {
    throw new UnrecoverableError(`Raw item ${rawItemId} not found`)
  }

  if (item.processingState !== 'ready_for_extraction') {
    log.debug({ raw_item_id: rawItemId, state: item.processingState }, 'skipping raw item')
    return
  }

  // Tier gate (execution-time). Auto-capture / AI feedback extraction is a
  // plan entitlement. Enforced HERE, at the single execution chokepoint —
  // not only at enqueue — so a job that was already queued when the tenant
  // downgraded (or re-enqueued by stuck-recovery or a manual retry) does not
  // run the LLM after the plan disallows it. Runs BEFORE the model lookup so a
  // disallowed item still terminates cleanly when the extraction model is also
  // unconfigured (otherwise it would throw and churn via stuck-recovery).
  // Terminal no-op mirrors the quality-gate path so it isn't re-picked.
  const { getTierLimits } = await import('@/lib/server/domains/settings/tier-limits.service')
  if (!(await getTierLimits()).features.aiFeedbackExtraction) {
    const context = (item.contextEnvelope ?? {}) as RawFeedbackItemContextEnvelope
    const isChannelMonitor =
      (context.metadata as Record<string, unknown> | undefined)?.ingestionMode === 'channel_monitor'
    const finalState = isChannelMonitor ? 'dismissed' : 'completed'
    log.debug({ raw_item_id: rawItemId, final_state: finalState }, 'plan disallows extraction')
    await logPipelineEvent({
      eventType: 'extraction.skipped_no_entitlement',
      rawFeedbackItemId: rawItemId,
      detail: { finalState, sourceType: item.sourceType },
    })
    await db
      .update(rawFeedbackItems)
      .set({
        processingState: finalState,
        stateChangedAt: new Date(),
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(rawFeedbackItems.id, rawItemId))
    return
  }

  const model = getChatModel('extraction')
  if (!isAiClientConfigured(config.openaiApiKey, config.openaiBaseUrl) || !model) {
    throw new UnrecoverableError('Extraction model not configured')
  }

  await db
    .update(rawFeedbackItems)
    .set({
      processingState: 'extracting',
      stateChangedAt: new Date(),
      attemptCount: sql`${rawFeedbackItems.attemptCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(rawFeedbackItems.id, rawItemId))

  try {
    let content = item.content as RawFeedbackContent
    const context = (item.contextEnvelope ?? {}) as RawFeedbackItemContextEnvelope

    // Quality gate: cheap LLM pre-classifier decides if content is actionable
    const gate = await shouldExtract({
      sourceType: item.sourceType,
      content,
      context,
      rawFeedbackItemId: rawItemId,
    })
    const isChannelMonitor =
      (context.metadata as Record<string, unknown> | undefined)?.ingestionMode === 'channel_monitor'

    if (!gate.extract) {
      // Channel-monitored items are 'dismissed' (auditable); others are 'completed'
      const finalState = isChannelMonitor ? 'dismissed' : 'completed'
      log.debug(
        { raw_item_id: rawItemId, final_state: finalState, reason: gate.reason },
        'quality gate filtered raw item'
      )

      await logPipelineEvent({
        eventType: 'quality_gate.rejected',
        rawFeedbackItemId: rawItemId,
        detail: {
          tier: gate.tier,
          reason: gate.reason,
          isChannelMonitor,
          sourceType: item.sourceType,
        },
      })

      await db
        .update(rawFeedbackItems)
        .set({
          processingState: finalState,
          stateChangedAt: new Date(),
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(rawFeedbackItems.id, rawItemId))
      return
    }

    await logPipelineEvent({
      eventType: 'quality_gate.passed',
      rawFeedbackItemId: rawItemId,
      detail: {
        tier: gate.tier,
        reason: gate.reason,
        isChannelMonitor,
        sourceType: item.sourceType,
        ...(gate.suggestedTitle ? { suggestedTitle: gate.suggestedTitle } : {}),
      },
    })

    // For channel-monitored items, use the AI-generated title if we don't have one
    if (gate.suggestedTitle && !content.subject) {
      content = { ...content, subject: gate.suggestedTitle }
      await db
        .update(rawFeedbackItems)
        .set({ content, updatedAt: new Date() })
        .where(eq(rawFeedbackItems.id, rawItemId))
    }

    const prompt = buildExtractionPrompt({
      sourceType: item.sourceType,
      content,
      context,
    })

    // Usage tokens for the raw item's own extractionInputTokens/OutputTokens
    // columns aren't on chat()'s resolved value (unlike the old completion
    // object) — captured via a second, local middleware alongside the usage
    // logger so those columns keep getting populated exactly as before.
    let capturedInputTokens: number | null = null
    let capturedOutputTokens: number | null = null
    const captureUsageMiddleware: ChatMiddleware = {
      name: 'extraction-usage-capture',
      onUsage(_ctx, usage) {
        if (typeof usage.promptTokens === 'number') capturedInputTokens = usage.promptTokens
        if (typeof usage.completionTokens === 'number')
          capturedOutputTokens = usage.completionTokens
      },
    }

    let result: z.infer<typeof ExtractionResultSchema>
    try {
      result = await chat({
        adapter: openaiCompatibleText(model, {
          baseURL: config.openaiBaseUrl!,
          apiKey: config.openaiApiKey!,
        }),
        messages: [{ role: 'user', content: prompt }],
        outputSchema: ExtractionResultSchema,
        stream: false,
        modelOptions: { max_tokens: 2000, ...structuredOutputProviderOptions() },
        middleware: [
          createUsageLoggingMiddleware({
            pipelineStep: 'extraction',
            model,
            rawFeedbackItemId: rawItemId,
            metadata: { promptVersion: EXTRACTION_PROMPT_VERSION },
          }),
          captureUsageMiddleware,
        ],
      })
    } catch (err) {
      // chat() throws with a distinguishing `.code` when the model's
      // response didn't validate against outputSchema (or was empty) —
      // mirrors the old hand-rolled 'Empty response...' /
      // 'Failed to parse extraction JSON...' / 'missing signals array'
      // UnrecoverableErrors, which were always terminal regardless of
      // attempts left. Any other error (network, rate limit, provider 5xx)
      // stays a plain Error so the retry-attempt accounting below still
      // applies exactly as before.
      const code = (err as { code?: unknown } | undefined)?.code
      if (
        code === 'structured-output-validation-failed' ||
        code === 'structured-output-missing-result'
      ) {
        throw new UnrecoverableError(
          `Extraction model returned invalid output: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      throw err
    }

    // Capture all signal types and confidences before filtering for audit
    const allSignalTypes = result.signals.map((s) => s.signalType)
    const allConfidences = result.signals
      .map((s) => (typeof s.confidence === 'number' ? s.confidence : null))
      .filter((c): c is number => c !== null)
    const totalRaw = result.signals.length

    const afterThreshold = result.signals.filter((s) =>
      typeof s.confidence === 'number' ? s.confidence >= 0.5 : true
    )
    const signalsBelowThreshold = totalRaw - afterThreshold.length

    const afterCap = afterThreshold.slice(0, 5)
    const signalsCapped = afterThreshold.length - afterCap.length

    result.signals = afterCap

    await db.delete(feedbackSignals).where(eq(feedbackSignals.rawFeedbackItemId, rawItemId))

    const signalIds: string[] = []
    if (result.signals.length > 0) {
      const inserted = await db
        .insert(feedbackSignals)
        .values(
          result.signals.map((s) => ({
            rawFeedbackItemId: rawItemId,
            signalType: s.signalType,
            summary: s.summary,
            evidence: s.evidence ?? [],
            implicitNeed: s.implicitNeed,
            extractionConfidence:
              typeof s.confidence === 'number' && !Number.isNaN(s.confidence)
                ? Math.max(0, Math.min(1, s.confidence))
                : 0.5,
            processingState: 'pending_interpretation' as const,
            extractionModel: model,
            extractionPromptVersion: EXTRACTION_PROMPT_VERSION,
          }))
        )
        .returning({ id: feedbackSignals.id })

      signalIds.push(...inserted.map((r) => r.id))
    }

    await logPipelineEvent({
      eventType: 'extraction.completed',
      rawFeedbackItemId: rawItemId,
      detail: {
        signalsExtracted: result.signals.length,
        signalsBelowThreshold,
        signalsCapped,
        signalTypes: allSignalTypes,
        confidences: allConfidences,
        model,
        promptVersion: EXTRACTION_PROMPT_VERSION,
      },
    })

    await db
      .update(rawFeedbackItems)
      .set({
        processingState: 'interpreting',
        stateChangedAt: new Date(),
        extractionInputTokens: capturedInputTokens,
        extractionOutputTokens: capturedOutputTokens,
        updatedAt: new Date(),
      })
      .where(eq(rawFeedbackItems.id, rawItemId))

    for (const signalId of signalIds) {
      await enqueueFeedbackAiJob({ type: 'interpret-signal', signalId })
    }

    if (signalIds.length === 0) {
      await db
        .update(rawFeedbackItems)
        .set({
          processingState: 'completed',
          stateChangedAt: new Date(),
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(rawFeedbackItems.id, rawItemId))
    }

    log.info({ signal_count: signalIds.length, raw_item_id: rawItemId }, 'extracted signals')
  } catch (error) {
    const terminal =
      error instanceof UnrecoverableError ||
      (attemptContext?.currentAttempt ?? 1) >= (attemptContext?.maxAttempts ?? 1)
    await logPipelineEvent({
      eventType: 'extraction.failed',
      rawFeedbackItemId: rawItemId,
      detail: {
        error: error instanceof Error ? error.message : String(error),
        attemptCount: (item.attemptCount ?? 0) + 1,
        terminal,
      },
    })

    await db
      .update(rawFeedbackItems)
      .set({
        processingState: terminal ? 'failed' : 'ready_for_extraction',
        stateChangedAt: new Date(),
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      })
      .where(eq(rawFeedbackItems.id, rawItemId))

    throw error
  }
}
