/**
 * Deterministic AI attribute classification (AI-ATTRIBUTES-PARITY-SPEC.md
 * Phase 1). Unlike Quinn's `set_attribute` tool (best-effort, only fires when
 * the model elects to call it mid-turn), this is a dedicated classification
 * pass: ONE structured-output chat call classifies every `ai_detect=true`
 * select definition against the conversation transcript, at defined "job
 * done" moments (handoff, assistant close, inactivity close, teammate close)
 * rather than depending on tool-call luck. Phase 2 adds a fifth moment,
 * `live_recheck` — every inbound customer message, while Quinn is
 * participating, when a LIVE workflow condition references an AI attribute
 * (the assistant orchestrator's cost gate) — narrowed via `restrictToKeys` to
 * just the attributes that gate actually references, never the full
 * catalogue.
 *
 * Writes go through the shared `setConversationAttribute` writer with
 * `src: 'ai'`, so the existing precedence rule (AI never overwrites a
 * non-AI value) applies unchanged. A result that would just reproduce the
 * value already on record is skipped before ever calling the writer (churn
 * avoidance — also keeps a re-classification at a later moment from spamming
 * the timeline with a no-op note).
 *
 * Every APPLIED write's reasoning is recorded as ONE combined internal note
 * per classification run (mirrors `appendAssistantHandoffNote` /
 * `appendAssistantPendingActionNote` in conversation.service.ts — an
 * agent-authored, inbox-only `conversation_messages` row — the established
 * durable-timeline mechanism for Quinn's automated actions). Authored under
 * `ensureAssistantPrincipal()` + `quinnActor`'s bounded identity, never a raw
 * service principal.
 *
 * Gated, in order: the `aiAttributeDetection` feature flag; a configured AI
 * client + `classification` chat model (the same getOpenAI()/getChatModel()
 * guard the other pipeline classifiers use — sentiment, quality-gate — rather
 * than importing the much larger assistant runtime module just for its
 * equivalent `isAssistantConfigured` check); `enforceAiTokenBudget()`; and at
 * least one enabled definition (narrowed to `detectOnClose` for the
 * `teammate_close` trigger). Every failure path (misconfiguration, a
 * malformed model response, a provider error) is caught and logged here —
 * this never throws into a caller, all of which invoke it fire-and-forget or
 * in a best-effort try/catch of their own.
 */
import { db, conversations, conversationMessages, eq } from '@/lib/server/db'
import type { ConversationId } from '@quackback/ids'
import {
  getOpenAI,
  stripCodeFences,
  structuredOutputProviderOptions,
} from '@/lib/server/domains/ai/config'
import { getChatModel } from '@/lib/server/domains/ai/models'
import { withRetry } from '@/lib/server/domains/ai/retry'
import { withUsageLogging } from '@/lib/server/domains/ai/usage-log'
import { enforceAiTokenBudget } from '@/lib/server/domains/settings/tier-enforce'
import { TierLimitError } from '@/lib/server/errors/tier-limit-error'
import { isFeatureEnabled } from '@/lib/server/domains/settings/settings.service'
import { loadConversationThread } from '@/lib/server/domains/assistant/assistant.thread'
import { ensureAssistantPrincipal } from '@/lib/server/domains/assistant/assistant.principal'
import { quinnActor } from '@/lib/server/domains/assistant/assistant.actor'
import { publishAgentConversationEvent } from '@/lib/server/realtime/conversation-channels'
import { toMessageDTO } from '@/lib/server/messages/message-core'
import { authorFromInput } from '@/lib/server/domains/conversation/conversation.query'
import { readAttributeValue } from '@/lib/shared/conversation/attribute-values'
import { logger } from '@/lib/server/logger'
import { listConversationAttributes } from './conversation-attribute.service'
import { setConversationAttribute } from './set-attribute.service'
import type { ConversationAttribute } from './conversation-attribute.types'

const log = logger.child({ component: 'ai-attribute-classification' })

/** The moments classification runs (AI-ATTRIBUTES-PARITY-SPEC.md §3). */
export type ClassificationTrigger =
  | 'handoff'
  | 'assistant_closed'
  | 'inactivity'
  | 'teammate_close'
  | 'live_recheck'

export interface ClassifyAttributesOptions {
  trigger: ClassificationTrigger
  /**
   * Narrow classification to just these keys (Phase 2 live re-check's cost
   * gate — only the attributes a live workflow condition actually
   * references, not every `ai_detect` definition). Applied as an
   * intersection with the per-trigger filter below (e.g. `teammate_close`'s
   * `detectOnClose` narrowing), never in place of it. Omit to classify every
   * enabled definition, as before.
   */
  restrictToKeys?: readonly string[]
}

/** One definition's classified outcome this run — only ever an APPLIED write (see module doc). */
export interface ClassificationOutcome {
  key: string
  applied: boolean
  reasoning: string
}

/**
 * Recent transcript budget for the classifier call. Same idea as sentiment's
 * `MAX_CONTENT_LENGTH` (bound the prompt regardless of thread length);
 * truncates the same direction as `conversation-summary.service.ts`'s
 * `buildTranscript` (keep the start, mark the cut) for consistency within
 * this codebase's transcript-to-LLM callers.
 */
const TRANSCRIPT_CHAR_BUDGET = 3000

const CLASSIFICATION_SYSTEM_PROMPT = `You are a classification engine for a customer support conversation.

You will be given a list of attribute definitions (each with a key, a label, a description, and its allowed options with an id/label/description) and the conversation transcript. For EACH attribute in the list, decide which option (if any) applies, based only on the transcript.

Rules:
- Refer to an option by its id, never its label.
- If nothing in the transcript clearly supports one option over the others for an attribute, set "optionId" to null. Do not guess.
- Base your decision only on the transcript given; never invent facts not present in it.
- Give one short sentence of reasoning per attribute, naming what in the transcript supports (or fails to support) your decision.
- Include exactly one result per attribute key you were given, in any order.

Respond with ONLY a single JSON object of this exact shape, and nothing else: {"results": [{"key": string, "optionId": string | null, "reasoning": string}]}`

/** Render the transcript as plain "Customer:"/"Agent:" lines, bounded by TRANSCRIPT_CHAR_BUDGET. */
function buildClassificationTranscript(
  messages: readonly { senderType: string; content: string | null }[]
): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.senderType === 'system') continue
    const content = m.content?.trim()
    if (!content) continue
    lines.push(`${m.senderType === 'visitor' ? 'Customer' : 'Agent'}: ${content}`)
  }
  const transcript = lines.join('\n')
  return transcript.length > TRANSCRIPT_CHAR_BUDGET
    ? transcript.slice(0, TRANSCRIPT_CHAR_BUDGET) + '\n\n[truncated]'
    : transcript
}

/** Render the attribute catalogue for the classifier prompt — descriptions
 *  double as the classifier's applies-if/does-not-apply-if guidance. */
function renderAttributeCatalogue(definitions: readonly ConversationAttribute[]): string {
  return definitions
    .map((d) => {
      const options = (d.options ?? [])
        .map((o) => `  - ${o.id}: ${o.label}${o.description ? ` (${o.description})` : ''}`)
        .join('\n')
      return [
        `Attribute "${d.key}" (${d.label}):${d.description ? ` ${d.description}` : ''}`,
        'Options:',
        options,
      ].join('\n')
    })
    .join('\n\n')
}

interface RawClassificationResult {
  key?: unknown
  optionId?: unknown
  reasoning?: unknown
}

/** Parse + validate the model's raw response into typed rows; malformed shapes yield []. */
function parseClassificationResponse(responseText: string): RawClassificationResult[] {
  let parsed: { results?: unknown }
  try {
    parsed = JSON.parse(stripCodeFences(responseText))
  } catch {
    return []
  }
  return Array.isArray(parsed.results) ? (parsed.results as RawClassificationResult[]) : []
}

/** One applied change, for the combined audit note. */
interface AppliedChange {
  label: string
  optionLabel: string
  reasoning: string
}

/**
 * Post ONE internal note recording every applied change this run (mirrors
 * `appendAssistantHandoffNote`'s shape — agent-authored, inbox-only,
 * `conversation_messages`). Best-effort: a failure here must never undo the
 * attribute writes that already landed, so it is caught and logged, not
 * propagated.
 */
async function recordClassificationNote(
  conversationId: ConversationId,
  applied: readonly AppliedChange[]
): Promise<void> {
  try {
    // Bounded Quinn identity (never a raw, role-inheriting service
    // principal) — mirrors the workflow engine's boundedServiceActor
    // pattern. Nothing in this flow is permission-checked (setConversationAttribute
    // takes no actor, and this note insert is the same unchecked shape
    // appendAssistantHandoffNote already uses), but the AUTHOR identity is
    // still Quinn's bounded actor, not an ambient admin-equivalent principal.
    const assistantPrincipal = await ensureAssistantPrincipal()
    const actor = quinnActor(assistantPrincipal.id)
    const author = { principalId: actor.principalId!, displayName: 'Quinn' }

    const lines = applied.map((a) => `- Set ${a.label} → ${a.optionLabel}: ${a.reasoning}`)
    const content = ['Quinn classified this conversation:', ...lines].join('\n')

    const [message] = await db
      .insert(conversationMessages)
      .values({
        conversationId,
        principalId: author.principalId,
        senderType: 'agent',
        isInternal: true,
        content,
      })
      .returning()
    const messageDTO = toMessageDTO(message, authorFromInput(author), author.principalId)
    publishAgentConversationEvent({ kind: 'message', conversationId, message: messageDTO })
  } catch (err) {
    log.warn({ err, conversationId }, 'failed to record ai attribute classification note')
  }
}

/**
 * Classify a conversation's enabled attributes and write through the shared
 * writer. Returns the outcomes for writes that actually landed (an invalid,
 * churn-skipped, or precedence-blocked result never appears in the returned
 * array — see the module doc). Never throws.
 */
export async function classifyConversationAttributes(
  conversationId: ConversationId,
  opts: ClassifyAttributesOptions
): Promise<ClassificationOutcome[]> {
  try {
    if (!(await isFeatureEnabled('aiAttributeDetection'))) return []

    const openai = getOpenAI()
    const model = getChatModel('classification')
    if (!openai || !model) return []

    try {
      await enforceAiTokenBudget()
    } catch (err) {
      if (err instanceof TierLimitError) {
        log.info(
          { conversationId, trigger: opts.trigger },
          'attribute classification skipped: ai token budget exceeded'
        )
        return []
      }
      throw err
    }

    const enabled = await listConversationAttributes({ aiDetectOnly: true })
    let definitions =
      opts.trigger === 'teammate_close' ? enabled.filter((d) => d.detectOnClose) : enabled
    if (opts.restrictToKeys) {
      const allow = new Set(opts.restrictToKeys)
      definitions = definitions.filter((d) => allow.has(d.key))
    }
    if (definitions.length === 0) return []

    const messages = await loadConversationThread(conversationId)
    const transcript = buildClassificationTranscript(messages)
    if (!transcript) return []

    const [row] = await db
      .select({ customAttributes: conversations.customAttributes })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
    const currentAttributes = (row?.customAttributes ?? {}) as Record<string, unknown>

    const userContent = [
      'Attributes to classify:',
      renderAttributeCatalogue(definitions),
      '',
      'Conversation transcript:',
      transcript,
    ].join('\n')

    const completion = await withUsageLogging(
      {
        pipelineStep: 'classification',
        callType: 'chat_completion',
        model,
        metadata: { conversationId, trigger: opts.trigger },
      },
      () =>
        withRetry(() =>
          openai.chat.completions.create({
            model,
            messages: [
              { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
              { role: 'user', content: userContent },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.1,
            max_tokens: 1500,
            ...structuredOutputProviderOptions(),
          })
        ),
      (r) => ({
        inputTokens: r.usage?.prompt_tokens ?? 0,
        outputTokens: r.usage?.completion_tokens,
        totalTokens: r.usage?.total_tokens ?? 0,
      })
    )

    const responseText = completion.choices?.[0]?.message?.content
    if (!responseText) return []
    const rawResults = parseClassificationResponse(responseText)
    if (rawResults.length === 0) return []

    const defsByKey = new Map(definitions.map((d) => [d.key, d]))
    const outcomes: ClassificationOutcome[] = []
    const appliedChanges: AppliedChange[] = []

    for (const raw of rawResults) {
      if (typeof raw.key !== 'string') continue
      const def = defsByKey.get(raw.key)
      if (!def) continue // unknown key — drop

      let optionId: string | null
      if (raw.optionId === null || raw.optionId === undefined) {
        optionId = null
      } else if (
        typeof raw.optionId === 'string' &&
        (def.options ?? []).some((o) => o.id === raw.optionId)
      ) {
        optionId = raw.optionId
      } else {
        continue // invalid optionId — drop
      }

      const reasoning =
        typeof raw.reasoning === 'string' && raw.reasoning.trim()
          ? raw.reasoning.trim()
          : 'No reasoning provided.'

      // Churn avoidance: a result that would just reproduce the value
      // already on record (whatever its source) never reaches the writer.
      const current = readAttributeValue(currentAttributes[def.key])
      if ((current?.v ?? null) === optionId) continue

      const updated = await setConversationAttribute({ conversationId }, def.key, optionId, 'ai')
      const applied =
        optionId === null
          ? updated[def.key] === undefined
          : readAttributeValue(updated[def.key])?.v === optionId
      if (!applied) continue // precedence rule blocked it (a human/workflow already owns the slot)

      outcomes.push({ key: def.key, applied: true, reasoning })
      const optionLabel =
        optionId === null
          ? '(cleared)'
          : ((def.options ?? []).find((o) => o.id === optionId)?.label ?? optionId)
      appliedChanges.push({ label: def.label, optionLabel, reasoning })
    }

    if (appliedChanges.length > 0) {
      await recordClassificationNote(conversationId, appliedChanges)
    }

    return outcomes
  } catch (err) {
    log.error({ err, conversationId, trigger: opts.trigger }, 'attribute classification failed')
    return []
  }
}
