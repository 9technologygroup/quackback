/**
 * Preview harness (AI-ATTRIBUTES-PARITY-SPEC.md Phase 3): classify a single
 * (possibly unsaved) attribute definition against an ephemeral sample
 * message, via the SAME `classification-core.ts` call the real classifier
 * uses. Mocking idiom mirrors ai-classification.service.test.ts (pure unit
 * test — the model call is the only external dependency worth mocking; the
 * classification-core module itself runs for real so preview provably
 * exercises the same prompt/validation path).
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

import { previewAttributeDetection } from '../attribute-preview.service'

function chatResponse(json: unknown, overrides: Record<string, unknown> = {}) {
  return {
    choices: [{ message: { content: JSON.stringify(json) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  }
}

const definition = {
  key: 'issue_type',
  label: 'Issue type',
  description: 'What the conversation is about.',
  options: [
    { id: 'opt_billing', label: 'Billing', description: 'A charge question.' },
    { id: 'opt_bug', label: 'Bug report', description: null },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsFeatureEnabled.mockResolvedValue(true)
  mockGetOpenAI.mockReturnValue(mockOpenAI as unknown)
  mockGetChatModel.mockReturnValue('test-classification-model')
  mockEnforceAiTokenBudget.mockResolvedValue(undefined)
})

describe('previewAttributeDetection: gating', () => {
  it('throws when the aiAttributeDetection flag is off', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false)
    await expect(
      previewAttributeDetection({ definition, sampleMessage: 'I was charged twice' })
    ).rejects.toMatchObject({ code: 'AI_ATTRIBUTE_DETECTION_DISABLED' })
    expect(mockOpenAI.chat.completions.create).not.toHaveBeenCalled()
  })

  it('throws when the AI client is not configured', async () => {
    mockGetOpenAI.mockReturnValue(null)
    await expect(
      previewAttributeDetection({ definition, sampleMessage: 'I was charged twice' })
    ).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' })
  })

  it('throws when the classification chat model is not configured', async () => {
    mockGetChatModel.mockReturnValue(null)
    await expect(
      previewAttributeDetection({ definition, sampleMessage: 'I was charged twice' })
    ).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' })
  })

  it('propagates a token-budget error', async () => {
    const { TierLimitError } = await import('@/lib/server/errors/tier-limit-error')
    mockEnforceAiTokenBudget.mockRejectedValue(
      new TierLimitError({ limit: 'aiTokensPerMonth', message: 'over budget' })
    )
    await expect(
      previewAttributeDetection({ definition, sampleMessage: 'I was charged twice' })
    ).rejects.toBeInstanceOf(TierLimitError)
  })

  it('rejects an empty sample message', async () => {
    await expect(
      previewAttributeDetection({ definition, sampleMessage: '   ' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(mockOpenAI.chat.completions.create).not.toHaveBeenCalled()
  })

  it('rejects a definition with no options', async () => {
    await expect(
      previewAttributeDetection({
        definition: { ...definition, options: [] },
        sampleMessage: 'I was charged twice',
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(mockOpenAI.chat.completions.create).not.toHaveBeenCalled()
  })
})

describe('previewAttributeDetection: happy path', () => {
  it('returns the predicted option id, label, and reasoning', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue(
      chatResponse({
        results: [
          {
            key: 'issue_type',
            optionId: 'opt_billing',
            reasoning: 'Customer says they were charged twice.',
          },
        ],
      })
    )
    const result = await previewAttributeDetection({
      definition,
      sampleMessage: 'I was charged twice for my subscription.',
    })
    expect(result).toEqual({
      optionId: 'opt_billing',
      optionLabel: 'Billing',
      reasoning: 'Customer says they were charged twice.',
    })
  })

  it('sends only the sample message as the transcript, prefixed as the customer', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue(
      chatResponse({ results: [{ key: 'issue_type', optionId: null, reasoning: 'Unclear.' }] })
    )
    await previewAttributeDetection({ definition, sampleMessage: 'Hello there' })
    const userMessage = mockOpenAI.chat.completions.create.mock.calls[0][0].messages.find(
      (m: { role: string }) => m.role === 'user'
    ).content
    expect(userMessage).toContain('Customer: Hello there')
  })

  it('returns a null optionId/optionLabel when nothing applies', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue(
      chatResponse({
        results: [{ key: 'issue_type', optionId: null, reasoning: 'Nothing matches.' }],
      })
    )
    const result = await previewAttributeDetection({
      definition,
      sampleMessage: 'Just saying hi.',
    })
    expect(result).toEqual({
      optionId: null,
      optionLabel: null,
      reasoning: 'Nothing matches.',
    })
  })

  it('falls back to a graceful result when the model returns nothing usable', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue(chatResponse({ notResults: true }))
    const result = await previewAttributeDetection({
      definition,
      sampleMessage: 'I was charged twice.',
    })
    expect(result).toEqual({
      optionId: null,
      optionLabel: null,
      reasoning: 'The model returned no usable result.',
    })
  })

  it('works with an unsaved definition (no persisted key)', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue(
      chatResponse({
        results: [{ key: 'preview_attribute', optionId: 'opt_billing', reasoning: 'x' }],
      })
    )
    const result = await previewAttributeDetection({
      definition: { ...definition, key: '' },
      sampleMessage: 'I was charged twice.',
    })
    expect(result.optionId).toBe('opt_billing')
  })
})
