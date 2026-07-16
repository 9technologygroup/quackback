/**
 * Tests for quality gate service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockConfig = vi.hoisted(() => ({
  openaiApiKey: 'test-key' as string | undefined,
  openaiBaseUrl: 'http://localhost:9999/v1' as string | undefined,
}))
vi.mock('@/lib/server/config', () => ({ config: mockConfig }))

const mockChat = vi.fn()
vi.mock('@tanstack/ai', () => ({
  chat: (...args: unknown[]) => mockChat(...args),
}))
vi.mock('@tanstack/ai-openai/compatible', () => ({
  openaiCompatibleText: (...args: unknown[]) => ({ kind: 'text', args }),
}))

vi.mock('@/lib/server/domains/ai/config', () => ({
  isAiClientConfigured: (apiKey?: string, baseUrl?: string) => Boolean(apiKey) && Boolean(baseUrl),
  structuredOutputProviderOptions: () => ({}),
}))

const mockCreateUsageLoggingMiddleware = vi.fn((..._args: unknown[]) => ({
  name: 'ai-usage-logging',
}))
vi.mock('@/lib/server/domains/ai/usage-middleware', () => ({
  createUsageLoggingMiddleware: (...args: unknown[]) => mockCreateUsageLoggingMiddleware(...args),
}))

vi.mock('@/lib/server/domains/ai/models', () => ({
  getChatModel: () => 'test-model',
  getEmbeddingModel: () => 'test-embedding-model',
}))

vi.mock('../prompts/quality-gate.prompt', () => ({
  buildQualityGatePrompt: vi.fn(() => 'mocked prompt'),
}))

describe('quality-gate.service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfig.openaiApiKey = 'test-key'
    mockConfig.openaiBaseUrl = 'http://localhost:9999/v1'
  })

  const makeItem = (text: string, sourceType = 'intercom') => ({
    sourceType,
    content: { text } as { subject?: string; text: string },
    context: {} as Record<string, unknown>,
  })

  it('should hard skip content with fewer than 5 words', async () => {
    const { shouldExtract } = await import('../quality-gate.service')
    const result = await shouldExtract(makeItem('ok thanks'))
    expect(result.extract).toBe(false)
    expect(result.tier).toBe(1)
    expect(result.reason).toContain('insufficient content')

    // Tier 1 skips should not call the LLM or usage logging
    expect(mockChat).not.toHaveBeenCalled()
    expect(mockCreateUsageLoggingMiddleware).not.toHaveBeenCalled()
  })

  it('should hard skip empty content', async () => {
    const { shouldExtract } = await import('../quality-gate.service')
    const result = await shouldExtract(makeItem(''))
    expect(result.extract).toBe(false)
  })

  it('should auto-pass quackback source with 15+ words', async () => {
    const { shouldExtract } = await import('../quality-gate.service')
    const longText = 'word '.repeat(20).trim()
    const result = await shouldExtract(makeItem(longText, 'quackback'))
    expect(result.extract).toBe(true)
    expect(result.tier).toBe(2)
    expect(result.reason).toContain('high-intent')
    // Should not call LLM or usage logging
    expect(mockChat).not.toHaveBeenCalled()
    expect(mockCreateUsageLoggingMiddleware).not.toHaveBeenCalled()
  })

  it('should auto-pass api source with 15+ words', async () => {
    const { shouldExtract } = await import('../quality-gate.service')
    const longText = 'word '.repeat(20).trim()
    const result = await shouldExtract(makeItem(longText, 'api'))
    expect(result.extract).toBe(true)
    expect(result.reason).toContain('high-intent')
  })

  it('should NOT auto-pass intercom source with 15+ words', async () => {
    mockChat.mockResolvedValueOnce({ extract: true, reason: 'has feedback' })

    const { shouldExtract } = await import('../quality-gate.service')
    const longText = 'word '.repeat(20).trim()
    const result = await shouldExtract(makeItem(longText, 'intercom'))
    // Should call LLM for intercom
    expect(mockChat).toHaveBeenCalled()
    expect(result.extract).toBe(true)
  })

  it('should return LLM gate result when extract=true', async () => {
    mockChat.mockResolvedValueOnce({ extract: true, reason: 'contains feedback' })

    const { shouldExtract } = await import('../quality-gate.service')
    const result = await shouldExtract(
      makeItem('I really wish you would add dark mode to the app please', 'intercom')
    )
    expect(result.extract).toBe(true)
    expect(result.tier).toBe(3)
    expect(result.reason).toBe('contains feedback')

    expect(mockCreateUsageLoggingMiddleware).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineStep: 'quality_gate',
        model: expect.any(String),
        metadata: expect.objectContaining({ promptVersion: 'v1', temperature: 0 }),
      })
    )

    // No temperature / max_completion_tokens on the request itself — the
    // OpenRouter require_parameters gate routes to zero providers otherwise.
    const callArgs = mockChat.mock.calls[0][0] as { modelOptions: Record<string, unknown> }
    expect(callArgs.modelOptions).not.toHaveProperty('temperature')
    expect(callArgs.modelOptions).not.toHaveProperty('max_completion_tokens')
    expect(callArgs.modelOptions.max_tokens).toBe(100)
  })

  it('should use a larger max_tokens budget for channel-monitored items', async () => {
    mockChat.mockResolvedValueOnce({
      extract: true,
      reason: 'ok',
      suggestedTitle: 'Dark mode request',
    })

    const { shouldExtract } = await import('../quality-gate.service')
    await shouldExtract({
      ...makeItem('I really wish you would add dark mode to the app please', 'slack'),
      context: { metadata: { ingestionMode: 'channel_monitor' } },
    })

    const callArgs = mockChat.mock.calls[0][0] as { modelOptions: Record<string, unknown> }
    expect(callArgs.modelOptions.max_tokens).toBe(200)
    expect(mockCreateUsageLoggingMiddleware).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ isChannelMonitor: true }),
      })
    )
  })

  it('should return LLM gate result when extract=false', async () => {
    mockChat.mockResolvedValueOnce({ extract: false, reason: 'just a greeting' })

    const { shouldExtract } = await import('../quality-gate.service')
    const result = await shouldExtract(
      makeItem('Hey there how are you doing today friend', 'intercom')
    )
    expect(result.extract).toBe(false)
    expect(result.tier).toBe(3)
    expect(result.reason).toBe('just a greeting')
  })

  it('should thread rawFeedbackItemId to usage logging', async () => {
    mockChat.mockResolvedValueOnce({ extract: true, reason: 'ok' })

    const { shouldExtract } = await import('../quality-gate.service')
    await shouldExtract({
      ...makeItem('I really want this feature added to the app please', 'intercom'),
      rawFeedbackItemId: 'raw_item_abc',
    })

    expect(mockCreateUsageLoggingMiddleware).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineStep: 'quality_gate',
        rawFeedbackItemId: 'raw_item_abc',
      })
    )
  })

  it('should pass through on LLM error', async () => {
    mockChat.mockRejectedValueOnce(new Error('API timeout'))

    const { shouldExtract } = await import('../quality-gate.service')
    const result = await shouldExtract(
      makeItem('I need the export feature to work better please fix it', 'intercom')
    )
    expect(result.extract).toBe(true)
    expect(result.reason).toContain('error')
  })

  it('should pass through when the model response fails schema validation', async () => {
    // chat() throws (rather than returning malformed JSON to hand-parse) when
    // the response doesn't conform to outputSchema — quality gate treats
    // this exactly like any other LLM error: fail open.
    const schemaErr = Object.assign(new Error('response did not match schema'), {
      code: 'structured-output-validation-failed',
    })
    mockChat.mockRejectedValueOnce(schemaErr)

    const { shouldExtract } = await import('../quality-gate.service')
    const result = await shouldExtract(
      makeItem('I need the export feature to work better please fix it', 'intercom')
    )
    expect(result.extract).toBe(true)
    expect(result.tier).toBe(3)
    expect(result.reason).toContain('error')
  })

  it('should fall back to word count when AI not configured', async () => {
    mockConfig.openaiApiKey = undefined

    const { shouldExtract } = await import('../quality-gate.service')

    // 15+ words should pass
    const longResult = await shouldExtract(makeItem('word '.repeat(20).trim(), 'intercom'))
    expect(longResult.extract).toBe(true)

    // <15 words but >=5 should fail
    const shortResult = await shouldExtract(
      makeItem('this is just seven words here total', 'intercom')
    )
    expect(shortResult.extract).toBe(false)
  })
})
