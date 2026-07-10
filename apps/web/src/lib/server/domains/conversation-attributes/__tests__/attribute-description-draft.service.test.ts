/**
 * "Draft descriptions" authoring assist (AI-ATTRIBUTES-PARITY-SPEC.md Phase
 * 3): one chat call that turns an attribute label + option labels into
 * applies-if/does-not-apply-if descriptions — the exact template both
 * Intercom and Featurebase's authoring docs tell admins to write themselves
 * with an external LLM. Mocking idiom mirrors ai-classification.service.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockOpenAI = {
  chat: { completions: { create: vi.fn() } },
}

const mockIsFeatureEnabled = vi.fn()
vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}))

const mockGetOpenAI = vi.fn(() => mockOpenAI as unknown)
const mockStructuredOutputProviderOptions = vi.fn(() => ({}))
vi.mock('@/lib/server/domains/ai/config', () => ({
  getOpenAI: () => mockGetOpenAI(),
  stripCodeFences: (s: string) => s.replace(/^```[\s\S]*?\n/, '').replace(/\n```$/, ''),
  structuredOutputProviderOptions: () => mockStructuredOutputProviderOptions(),
}))

const mockGetChatModel = vi.fn((_feature?: string): string | null => 'test-classification-model')
vi.mock('@/lib/server/domains/ai/models', () => ({
  getChatModel: (feature: string) => mockGetChatModel(feature),
}))

vi.mock('@/lib/server/domains/ai/retry', () => ({
  withRetry: (fn: () => Promise<unknown>) =>
    fn().then((result: unknown) => ({ result, retryCount: 0 })),
}))

vi.mock('@/lib/server/domains/ai/usage-log', () => ({
  withUsageLogging: vi.fn((_params: unknown, fn: () => Promise<{ result: unknown }>) =>
    fn().then(({ result }) => result)
  ),
}))

const mockEnforceAiTokenBudget = vi.fn()
vi.mock('@/lib/server/domains/settings/tier-enforce', () => ({
  enforceAiTokenBudget: (...args: unknown[]) => mockEnforceAiTokenBudget(...args),
}))

import { draftAttributeDescriptions } from '../attribute-description-draft.service'

function chatResponse(json: unknown, overrides: Record<string, unknown> = {}) {
  return {
    choices: [{ message: { content: JSON.stringify(json) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsFeatureEnabled.mockResolvedValue(true)
  mockGetOpenAI.mockReturnValue(mockOpenAI as unknown)
  mockGetChatModel.mockReturnValue('test-classification-model')
  mockEnforceAiTokenBudget.mockResolvedValue(undefined)
})

describe('draftAttributeDescriptions: gating', () => {
  it('throws when the inboxAi flag is off', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false)
    await expect(
      draftAttributeDescriptions({ label: 'Issue type', optionLabels: ['Billing', 'Bug'] })
    ).rejects.toMatchObject({ code: 'AI_ATTRIBUTE_DETECTION_DISABLED' })
    expect(mockOpenAI.chat.completions.create).not.toHaveBeenCalled()
  })

  it('throws when AI is not configured', async () => {
    mockGetOpenAI.mockReturnValue(null)
    await expect(
      draftAttributeDescriptions({ label: 'Issue type', optionLabels: ['Billing'] })
    ).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' })
  })

  it('rejects an empty label', async () => {
    await expect(
      draftAttributeDescriptions({ label: '   ', optionLabels: ['Billing'] })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('rejects zero option labels', async () => {
    await expect(
      draftAttributeDescriptions({ label: 'Issue type', optionLabels: [] })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})

describe('draftAttributeDescriptions: happy path', () => {
  it('returns an attribute description and one description per option, in the given order', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue(
      chatResponse({
        attributeDescription: 'What kind of issue the customer has.',
        options: [
          { label: 'Bug report', description: 'Applies when something is broken.' },
          { label: 'Billing', description: 'Applies when the customer asks about a charge.' },
        ],
      })
    )
    const result = await draftAttributeDescriptions({
      label: 'Issue type',
      optionLabels: ['Billing', 'Bug report'],
    })
    expect(result.attributeDescription).toBe('What kind of issue the customer has.')
    // Re-ordered to match the INPUT optionLabels order, not the model's order.
    expect(result.options).toEqual([
      { label: 'Billing', description: 'Applies when the customer asks about a charge.' },
      { label: 'Bug report', description: 'Applies when something is broken.' },
    ])
  })

  it('falls back to an empty description for an option the model omitted', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue(
      chatResponse({
        attributeDescription: 'desc',
        options: [{ label: 'Billing', description: 'x' }],
      })
    )
    const result = await draftAttributeDescriptions({
      label: 'Issue type',
      optionLabels: ['Billing', 'Bug report'],
    })
    expect(result.options).toEqual([
      { label: 'Billing', description: 'x' },
      { label: 'Bug report', description: '' },
    ])
  })

  it('throws on a malformed model response', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue(chatResponse({ notTheShape: true }))
    await expect(
      draftAttributeDescriptions({ label: 'Issue type', optionLabels: ['Billing'] })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})
