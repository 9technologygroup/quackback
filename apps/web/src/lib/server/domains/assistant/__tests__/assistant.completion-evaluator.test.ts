import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig = vi.hoisted(() => ({
  openaiApiKey: 'test-key',
  openaiBaseUrl: 'http://localhost:9999/v1',
}))
vi.mock('@/lib/server/config', () => ({ config: mockConfig }))

const mockChat = vi.fn()
vi.mock('@tanstack/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/ai')>()
  return { ...actual, chat: (...args: unknown[]) => mockChat(...args) }
})
vi.mock('@tanstack/ai-openai/compatible', () => ({
  openaiCompatibleText: () => ({ kind: 'text' }),
}))

const mockWithUsageLogging = vi.fn()
vi.mock('@/lib/server/domains/ai/usage-log', () => ({
  withUsageLogging: (...args: unknown[]) => mockWithUsageLogging(...args),
}))

import { evaluateZeroToolCompletion } from '../assistant.completion-evaluator'

function completeRun(object: unknown) {
  return (async function* () {
    yield { type: 'TEXT_MESSAGE_CONTENT', delta: JSON.stringify(object) }
    yield { type: 'CUSTOM', name: 'structured-output.complete', value: { object } }
    yield {
      type: 'RUN_FINISHED',
      usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
    }
  })()
}

beforeEach(() => {
  vi.clearAllMocks()
  mockWithUsageLogging.mockImplementation(
    async (
      _params: unknown,
      fn: () => Promise<{ result: unknown; retryCount: number }>,
      extract: (result: unknown) => unknown
    ) => {
      const { result } = await fn()
      extract(result)
      return result
    }
  )
})

describe('evaluateZeroToolCompletion', () => {
  it('returns the structured verdict without exposing any action tools', async () => {
    mockChat.mockImplementation(() =>
      completeRun({ decision: 'retry', reason: 'incomplete_sentence' })
    )

    const verdict = await evaluateZeroToolCompletion({
      model: 'test-model',
      messages: [{ sender: 'customer', content: 'Tell me about Quackback' }],
      candidate: "I'm not familiar with anything called",
      availableTools: ['search_knowledge', 'report_inability'],
      surface: 'widget',
      conversationId: 'conversation_1',
    })

    expect(verdict).toEqual({ decision: 'retry', reason: 'incomplete_sentence' })
    const chatOptions = mockChat.mock.calls[0]?.[0] as Record<string, unknown>
    expect(chatOptions).not.toHaveProperty('tools')
    expect(chatOptions).not.toHaveProperty('context')
    expect(chatOptions).not.toHaveProperty('agentLoopStrategy')
    expect(mockWithUsageLogging).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineStep: 'assistant_completion_evaluator',
        metadata: {
          conversationId: 'conversation_1',
          surface: 'widget',
          attempt: 0,
        },
      }),
      expect.any(Function),
      expect.any(Function)
    )
  })

  it('rejects a non-conformant evaluator response instead of silently accepting it', async () => {
    mockChat.mockImplementation(() => completeRun({ decision: 'maybe', reason: 'unknown' }))

    await expect(
      evaluateZeroToolCompletion({
        model: 'test-model',
        messages: [{ sender: 'customer', content: 'Tell me about Quackback' }],
        candidate: 'I do not know.',
        availableTools: ['search_knowledge'],
        surface: 'widget',
        conversationId: 'conversation_1',
      })
    ).rejects.toThrow()
  })
})
