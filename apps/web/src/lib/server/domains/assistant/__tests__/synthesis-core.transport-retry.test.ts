/**
 * Tests for the transport-retry layer in synthesis-core's runOneAttempt (H1).
 *
 * The boundary under test: a pristine PRE-COMMIT dial failure (429/5xx/network,
 * thrown before any chunk is consumed) is re-dialed; a POST-COMMIT failure
 * (anything after the first chunk — streamed text, executed tool, or a RUN_ERROR
 * chunk) and any abort are NOT, because a re-dial could double-emit or
 * double-persist. The semantic-salvage retry (runSynthesis' `retries`) is a
 * separate layer; these tests pin it to 0 to isolate transport behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'

const mockChat = vi.fn()
const mockAdapterFactory = vi.fn((..._args: unknown[]) => ({ kind: 'text' }))

const mockConfig = vi.hoisted(() => ({
  openaiApiKey: 'test-key' as string | undefined,
  openaiBaseUrl: 'http://localhost:9999/v1' as string | undefined,
}))

vi.mock('@/lib/server/config', () => ({ config: mockConfig }))

vi.mock('@tanstack/ai', () => ({
  chat: (...args: unknown[]) => mockChat(...args),
  parsePartialJSON: (s: string) => {
    try {
      return JSON.parse(s)
    } catch {
      return undefined
    }
  },
}))

vi.mock('@tanstack/ai-openai/compatible', () => ({
  openaiCompatibleText: (...args: unknown[]) => mockAdapterFactory(...args),
}))

vi.mock('@/lib/server/domains/ai/config', () => ({
  stripCodeFences: (s: string) => s,
  structuredOutputProviderOptions: () => ({}),
}))

const mockWithUsageLogging = vi.fn()
vi.mock('@/lib/server/domains/ai/usage-log', () => ({
  withUsageLogging: (...args: unknown[]) => mockWithUsageLogging(...args),
}))

import { runSynthesis, type RunSynthesisOptions } from '../synthesis-core'

/** Stream that throws on first pull — a pre-commit dial failure (no chunk consumed). */
function throwingStream(err: Error): AsyncGenerator<unknown> {
  // eslint-disable-next-line require-yield -- models a dial that rejects before yielding
  return (async function* () {
    throw err
  })()
}

/** Stream that yields a chunk (commit) then throws — a post-commit failure. */
function emitThenThrow(err: Error) {
  return (async function* () {
    yield { type: 'TEXT_MESSAGE_CONTENT', delta: '{"text":"partial' }
    throw err
  })()
}

/** Stream that produces a valid structured object. */
function goodStream(text: string) {
  const object = { text }
  return (async function* () {
    yield { type: 'TEXT_MESSAGE_CONTENT', delta: JSON.stringify(object) }
    yield { type: 'CUSTOM', name: 'structured-output.complete', value: { object } }
    yield { type: 'RUN_FINISHED', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
  })()
}

function baseOptions(
  overrides: Partial<RunSynthesisOptions<string>> = {}
): RunSynthesisOptions<string> {
  return {
    model: 'test-model',
    systemPrompts: ['sys'],
    messages: [{ role: 'user', content: 'q' }],
    outputSchema: z.object({ text: z.string() }),
    deltaField: 'text',
    salvageMode: 'forgiving',
    salvage: () => null,
    onFailure: 'throw',
    retries: 0, // isolate transport retry from semantic-salvage retry
    usageLogParams: { pipelineStep: 'assistant', callType: 'chat_completion', model: 'test-model' },
    deriveAnswerKind: () => 'answered',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  mockConfig.openaiApiKey = 'test-key'
  mockConfig.openaiBaseUrl = 'http://localhost:9999/v1'
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

afterEach(() => {
  vi.useRealTimers()
})

/** Drive a promise to completion while flushing the retry-backoff timers. */
async function settle<T>(p: Promise<T>): Promise<T> {
  // Attach handlers synchronously so a rejection during the timer flush is
  // never briefly "unhandled" (which vitest fails the run on).
  const captured = p.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e })
  )
  await vi.runAllTimersAsync()
  const r = await captured
  if (r.ok) return r.v
  throw r.e
}

describe('transport retry (H1)', () => {
  it('re-dials a pristine pre-commit transport failure and succeeds', async () => {
    mockChat
      .mockReturnValueOnce(throwingStream(new Error('429 Too Many Requests')))
      .mockReturnValueOnce(goodStream('recovered'))

    const result = await settle(runSynthesis(baseOptions()))

    expect(result).toEqual({
      outcome: 'success',
      final: { text: 'recovered' },
      usage: expect.anything(),
    })
    // Two dials within a single semantic attempt (retries: 0).
    expect(mockChat).toHaveBeenCalledTimes(2)
  })

  it('retries a 5xx pre-commit failure', async () => {
    mockChat
      .mockReturnValueOnce(throwingStream(new Error('503 Service Unavailable')))
      .mockReturnValueOnce(goodStream('ok'))

    const result = await settle(runSynthesis(baseOptions()))
    expect((result as { final: unknown }).final).toEqual({ text: 'ok' })
    expect(mockChat).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a post-commit failure (a chunk was already consumed)', async () => {
    // A mid-stream network drop after text streamed: re-dialing would double-emit.
    mockChat.mockReturnValueOnce(emitThenThrow(new Error('ECONNRESET')))

    await expect(settle(runSynthesis(baseOptions()))).rejects.toThrow('ECONNRESET')
    expect(mockChat).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a RUN_ERROR chunk (in-stream, always post-commit)', async () => {
    mockChat.mockReturnValueOnce(
      (async function* () {
        yield { type: 'RUN_ERROR', message: 'provider exploded' }
      })()
    )

    await expect(settle(runSynthesis(baseOptions()))).rejects.toThrow('provider exploded')
    expect(mockChat).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a non-retryable transport error (4xx)', async () => {
    mockChat.mockReturnValueOnce(throwingStream(new Error('400 invalid model ID')))

    await expect(settle(runSynthesis(baseOptions()))).rejects.toThrow('400 invalid model ID')
    expect(mockChat).toHaveBeenCalledTimes(1)
  })

  it('surfaces the original error (not the internal wrapper) to the caller', async () => {
    mockChat.mockReturnValue(emitThenThrow(new Error('socket hang up mid-stream')))

    await expect(settle(runSynthesis(baseOptions()))).rejects.toThrow('socket hang up mid-stream')
  })

  it('an abort before the dial bypasses retry entirely', async () => {
    const controller = new AbortController()
    controller.abort()
    // Adapter with an already-aborted controller rejects at dial time.
    mockChat.mockImplementation(() => throwingStream(new Error('The operation was aborted')))

    await expect(settle(runSynthesis(baseOptions({ signal: controller.signal })))).rejects.toThrow()
    // No re-dial after an abort.
    expect(mockChat).toHaveBeenCalledTimes(1)
  })

  it('exhausts the transport budget then surfaces the last transport error', async () => {
    // Fresh generator per dial (a generator is single-use).
    mockChat.mockImplementation(() => throwingStream(new Error('429 rate limit')))

    await expect(settle(runSynthesis(baseOptions()))).rejects.toThrow('429 rate limit')
    // Initial dial + TRANSPORT_RETRIES (2) re-dials.
    expect(mockChat).toHaveBeenCalledTimes(3)
  })
})
