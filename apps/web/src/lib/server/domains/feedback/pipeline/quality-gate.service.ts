/**
 * Quality gate — cheap LLM pre-classifier for raw feedback items.
 *
 * Decides whether content is actionable product feedback before
 * spending tokens on the full extraction model. Uses a tiered approach:
 *
 * 1. Hard skip: trivially empty content (< 5 words)
 * 2. Auto-pass: high-intent sources (quackback, api, slack shortcut) with 15+ words
 * 3. LLM gate: everything else gets a cheap model call
 *
 * For channel-monitored items, the LLM gate also generates a suggested title
 * since there is no human-provided one.
 */

import { chat } from '@tanstack/ai'
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible'
import { z } from 'zod'
import { config } from '@/lib/server/config'
import {
  isAiClientConfigured,
  structuredOutputProviderOptions,
} from '@/lib/server/domains/ai/config'
import { createUsageLoggingMiddleware } from '@/lib/server/domains/ai/usage-middleware'
import { getChatModel } from '@/lib/server/domains/ai/models'
import { buildQualityGatePrompt } from './prompts/quality-gate.prompt'
import { logger } from '@/lib/server/logger'
import type { RawFeedbackContent, RawFeedbackItemContextEnvelope } from '../types'

const log = logger.child({ component: 'quality-gate' })

// Mirrors the quality-gate prompt's contract (prompts/quality-gate.prompt.ts).
// All fields optional: the old hand-parsed path treated a missing `extract`
// as pass-through-true and a missing `reason` as a placeholder string, and
// `suggestedTitle` is only requested for channel-monitored items.
const QualityGateResponseSchema = z.object({
  extract: z.boolean().optional(),
  reason: z.string().optional(),
  suggestedTitle: z.string().optional(),
})

/** Sources where users intentionally submit feedback — high baseline intent. */
const HIGH_INTENT_SOURCES = new Set(['api', 'quackback'])

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 1).length
}

function getIngestionMode(context: RawFeedbackItemContextEnvelope): string | undefined {
  return (context.metadata as Record<string, unknown> | undefined)?.ingestionMode as
    | string
    | undefined
}

function isHighIntent(item: {
  sourceType: string
  context: RawFeedbackItemContextEnvelope
}): boolean {
  if (HIGH_INTENT_SOURCES.has(item.sourceType)) return true
  // Slack shortcut = human-curated, high trust
  if (item.sourceType === 'slack' && getIngestionMode(item.context) === 'shortcut') return true
  return false
}

export interface QualityGateResult {
  extract: boolean
  reason: string
  /** Which tier decided: 1 = hard skip, 2 = auto-pass, 3 = LLM gate */
  tier: 1 | 2 | 3
  /** AI-generated title for channel-monitored items that pass the gate. */
  suggestedTitle?: string
}

export async function shouldExtract(item: {
  sourceType: string
  content: RawFeedbackContent
  context: RawFeedbackItemContextEnvelope
  rawFeedbackItemId?: string
}): Promise<QualityGateResult> {
  const combinedText = [item.content.subject, item.content.text].filter(Boolean).join(' ')
  const words = wordCount(combinedText)

  // Tier 1: Hard skip — trivially empty content
  if (words < 5) {
    return { extract: false, tier: 1, reason: `insufficient content (${words} words)` }
  }

  // Tier 2: Auto-pass — high-intent sources with enough substance
  if (isHighIntent(item) && words >= 15) {
    return { extract: true, tier: 2, reason: 'high-intent source with sufficient content' }
  }

  // Tier 3: LLM gate
  const model = getChatModel('qualityGate')
  if (!isAiClientConfigured(config.openaiApiKey, config.openaiBaseUrl) || !model) {
    // AI not configured — fall back to permissive behavior
    return {
      extract: words >= 15,
      tier: 3,
      reason: 'AI not configured, falling back to word count',
    }
  }

  const isChannelMonitor = getIngestionMode(item.context) === 'channel_monitor'

  try {
    const prompt = buildQualityGatePrompt(item)

    const result = await chat({
      adapter: openaiCompatibleText(model, {
        baseURL: config.openaiBaseUrl!,
        apiKey: config.openaiApiKey!,
      }),
      messages: [{ role: 'user', content: prompt }],
      outputSchema: QualityGateResponseSchema,
      stream: false,
      modelOptions: {
        max_tokens: isChannelMonitor ? 200 : 100,
        ...structuredOutputProviderOptions(),
      },
      middleware: [
        createUsageLoggingMiddleware({
          pipelineStep: 'quality_gate',
          model,
          rawFeedbackItemId: item.rawFeedbackItemId,
          metadata: { promptVersion: 'v1', isChannelMonitor, temperature: 0 },
        }),
      ],
    })

    return {
      extract: result.extract !== false,
      tier: 3,
      reason: result.reason ?? 'no reason provided',
      suggestedTitle: result.suggestedTitle,
    }
  } catch (error) {
    // Quality gate failure should never block the pipeline — pass through.
    // Covers both a transport/provider error and chat() throwing on a
    // response that didn't validate against outputSchema (the old code's
    // distinct 'empty response' / JSON-parse-failure branches collapse into
    // this same fail-open path, same as any other LLM error did before).
    log.warn({ err: error }, 'llm call failed, passing through')
    return { extract: true, tier: 3, reason: 'quality gate error, passing through' }
  }
}
