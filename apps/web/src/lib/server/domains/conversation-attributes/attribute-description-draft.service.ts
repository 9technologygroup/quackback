/**
 * "Draft descriptions" authoring assist (AI-ATTRIBUTES-PARITY-SPEC.md Phase
 * 3): one chat call that turns an attribute label + its option labels into
 * applies-if/does-not-apply-if/likely-phrasing descriptions — the exact
 * template both Intercom's and Featurebase's authoring docs tell admins to
 * write themselves with an external LLM (AI-ATTRIBUTES-PARITY-SPEC.md §1's
 * "Authoring guidance" row). Building it in turns a documented manual
 * workaround into a button.
 *
 * Reuses the same flag/config/budget gate and `classification` chat model as
 * the real classifier and the preview harness — this is authoring tooling
 * for the same feature area, not a separate AI surface with its own dial.
 * Not part of `classification-core.ts`: the request/response shape here
 * (attribute + option descriptions) is unrelated to classifying a
 * transcript, so sharing would only entangle two different prompts.
 *
 * Like the preview harness (and unlike the fire-and-forget real classifier),
 * this is a foreground, admin-invoked action — gating and parsing failures
 * are thrown, not swallowed, so the editor can surface them.
 */
import {
  getOpenAI,
  stripCodeFences,
  structuredOutputProviderOptions,
} from '@/lib/server/domains/ai/config'
import { getChatModel } from '@/lib/server/domains/ai/models'
import { withRetry } from '@/lib/server/domains/ai/retry'
import { withUsageLogging } from '@/lib/server/domains/ai/usage-log'
import { enforceAiTokenBudget } from '@/lib/server/domains/settings/tier-enforce'
import { isFeatureEnabled } from '@/lib/server/domains/settings/settings.service'
import { ValidationError } from '@/lib/shared/errors'

const DRAFT_SYSTEM_PROMPT = `You help an admin write descriptions for a customer-support conversation attribute that an AI classifier will use to categorize conversations.

Write ONE short description for the attribute itself, explaining what it captures.
For EACH option, write a short description following this template: when it applies, when it does NOT apply, and 1-2 phrases a customer might typically use that indicate it. Keep each description under 300 characters.

Respond with ONLY a single JSON object of this exact shape, and nothing else: {"attributeDescription": string, "options": [{"label": string, "description": string}]}. Include exactly one entry per option label given, using the exact label text given, in any order.`

export interface DraftAttributeDescriptionsInput {
  label: string
  optionLabels: string[]
}

export interface DraftAttributeDescriptionsResult {
  attributeDescription: string
  options: { label: string; description: string }[]
}

export async function draftAttributeDescriptions(
  input: DraftAttributeDescriptionsInput
): Promise<DraftAttributeDescriptionsResult> {
  if (!(await isFeatureEnabled('inboxAi'))) {
    throw new ValidationError(
      'AI_ATTRIBUTE_DETECTION_DISABLED',
      'AI attribute detection is turned off'
    )
  }
  const openai = getOpenAI()
  const model = getChatModel('classification')
  if (!openai || !model) {
    throw new ValidationError('AI_NOT_CONFIGURED', 'AI is not configured')
  }
  await enforceAiTokenBudget()

  const label = input.label.trim()
  const optionLabels = input.optionLabels.map((l) => l.trim()).filter(Boolean)
  if (!label) throw new ValidationError('VALIDATION_ERROR', 'Attribute label is required')
  if (optionLabels.length === 0) {
    throw new ValidationError('VALIDATION_ERROR', 'At least one option label is required')
  }

  const userContent = [
    `Attribute label: ${label}`,
    'Option labels:',
    ...optionLabels.map((l) => `- ${l}`),
  ].join('\n')

  const completion = await withUsageLogging(
    {
      pipelineStep: 'classification',
      callType: 'chat_completion',
      model,
      metadata: { pipelineContext: 'attribute_description_draft' },
    },
    () =>
      withRetry(() =>
        openai.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: DRAFT_SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.3,
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
  if (!responseText) {
    throw new ValidationError('VALIDATION_ERROR', 'The model returned no response')
  }

  let parsed: { attributeDescription?: unknown; options?: unknown }
  try {
    parsed = JSON.parse(stripCodeFences(responseText))
  } catch {
    throw new ValidationError('VALIDATION_ERROR', 'The model returned an unparseable response')
  }
  if (!Array.isArray(parsed.options)) {
    throw new ValidationError('VALIDATION_ERROR', 'The model returned an unexpected response shape')
  }

  const attributeDescription =
    typeof parsed.attributeDescription === 'string' ? parsed.attributeDescription.trim() : ''

  const byLabel = new Map<string, string>()
  for (const raw of parsed.options) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as { label?: unknown; description?: unknown }
    if (typeof entry.label !== 'string') continue
    byLabel.set(entry.label, typeof entry.description === 'string' ? entry.description.trim() : '')
  }

  // Re-ordered (and re-keyed) to match the caller's INPUT order — the model's
  // response order/labels are not trusted verbatim, mirroring the real
  // classifier's key-matching-against-the-known-set discipline.
  const options = optionLabels.map((optLabel) => ({
    label: optLabel,
    description: byLabel.get(optLabel) ?? '',
  }))

  return { attributeDescription, options }
}
