import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeKbArticle } from './kb-fixtures'

const mockConfig = vi.hoisted(() => ({
  openaiApiKey: 'test-key' as string | undefined,
  openaiBaseUrl: 'http://localhost:9999/v1' as string | undefined,
  aiChatModel: 'test-model' as string | undefined,
  aiSummaryModel: undefined,
  aiSentimentModel: undefined,
  aiExtractionModel: undefined,
  aiQualityGateModel: undefined,
  aiInterpretationModel: undefined,
  aiMergeModel: undefined,
  aiHelpCenterModel: undefined,
  aiEmbeddingModel: undefined,
}))
vi.mock('@/lib/server/config', () => ({ config: mockConfig }))

const mockChat = vi.fn()
// Keep the real toolDefinition / maxIterations / parsePartialJSON; only the
// model call is mocked, so tool wiring and JSON streaming are exercised for real.
vi.mock('@tanstack/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/ai')>()
  return { ...actual, chat: (...args: unknown[]) => mockChat(...args) }
})
vi.mock('@tanstack/ai-openai/compatible', () => ({
  openaiCompatibleText: () => ({ kind: 'text' }),
}))

const mockRetrieve = vi.fn()
vi.mock('../retrieval', () => ({
  retrieveKbArticles: (...args: unknown[]) => mockRetrieve(...args),
}))

// The runtime never triggers get_conversation_context in these tests; stub the
// conversation query so importing the tool module stays hermetic.
vi.mock('@/lib/server/domains/conversation/conversation.query', () => ({
  listMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false, nextCursor: null }),
}))

const mockWithUsageLogging = vi.fn()
vi.mock('@/lib/server/domains/ai/usage-log', () => ({
  withUsageLogging: (...args: unknown[]) => mockWithUsageLogging(...args),
}))

import {
  runAssistantTurn,
  respondEligible,
  assembleCitations,
  decideEscalation,
  isSubstantiveAnswer,
  buildAssistantSystemPrompt,
  isAssistantConfigured,
  AssistantNotConfiguredError,
  type AssistantThreadMessage,
} from '../assistant.runtime'
import type { AssistantCitation } from '../assistant.tools'

/** Async-iterable of scripted chunks. */
function chunkStream(chunks: unknown[]) {
  return (async function* () {
    for (const c of chunks) yield c
  })()
}

function completeRun(object: unknown) {
  return [
    { type: 'TEXT_MESSAGE_CONTENT', delta: JSON.stringify(object) },
    { type: 'CUSTOM', name: 'structured-output.complete', value: { object } },
    { type: 'RUN_FINISHED', usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 } },
  ]
}

const customerAsks = (content: string): AssistantThreadMessage[] => [
  { sender: 'customer', content },
]

const baseInput = {
  assistantPrincipalId: 'principal_assistant' as never,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConfig.openaiApiKey = 'test-key'
  mockConfig.openaiBaseUrl = 'http://localhost:9999/v1'
  mockConfig.aiChatModel = 'test-model'
  mockConfig.aiHelpCenterModel = undefined
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

describe('respondEligible (silence rule)', () => {
  it('is eligible when no human teammate has replied', () => {
    expect(respondEligible([{ sender: 'customer', content: 'hi' }])).toBe(true)
  })

  it('mutes Quinn after a human teammate replies past its last message', () => {
    expect(
      respondEligible([
        { sender: 'customer', content: 'hi' },
        { sender: 'assistant', content: 'hello' },
        { sender: 'human_agent', content: 'I got this' },
        { sender: 'customer', content: 'thanks' },
      ])
    ).toBe(false)
  })

  it('stays eligible when Quinn spoke after the human teammate', () => {
    expect(
      respondEligible([
        { sender: 'human_agent', content: 'earlier note' },
        { sender: 'assistant', content: 'back to me' },
        { sender: 'customer', content: 'another question' },
      ])
    ).toBe(true)
  })

  it('mutes when a human is already handling and Quinn never spoke', () => {
    expect(
      respondEligible([
        { sender: 'customer', content: 'hi' },
        { sender: 'human_agent', content: 'a human replies' },
        { sender: 'customer', content: 'ok' },
      ])
    ).toBe(false)
  })
})

describe('assembleCitations', () => {
  const ledger = new Map<string, AssistantCitation>([
    [
      'kb_article_1',
      { type: 'article', id: 'kb_article_1', title: 'T1', url: '/hc/articles/g/a1' },
    ],
  ])

  it('keeps only surfaced ids, enriched from the ledger', () => {
    expect(assembleCitations([{ type: 'article', id: 'kb_article_1' }], ledger)).toEqual([
      { type: 'article', id: 'kb_article_1', title: 'T1', url: '/hc/articles/g/a1' },
    ])
  })

  it('drops hallucinated ids and dedupes', () => {
    expect(
      assembleCitations(
        [
          { type: 'article', id: 'kb_article_1' },
          { type: 'article', id: 'kb_article_HALLUCINATED' },
          { type: 'article', id: 'kb_article_1' },
        ],
        ledger
      )
    ).toEqual([{ type: 'article', id: 'kb_article_1', title: 'T1', url: '/hc/articles/g/a1' }])
  })

  it('drops everything when nothing cleared the confidence floor (empty ledger)', () => {
    expect(assembleCitations([{ type: 'article', id: 'kb_article_1' }], new Map())).toEqual([])
  })
})

describe('decideEscalation (single offer)', () => {
  it('is undefined when the model flags no escalation', () => {
    expect(decideEscalation(undefined, false)).toBeUndefined()
    expect(decideEscalation(null, true)).toBeUndefined()
  })

  it('offers on the first trigger', () => {
    expect(decideEscalation('frustration', false)).toEqual({ reason: 'frustration', mode: 'offer' })
  })

  it('escalates immediately on a repeat trigger (never offered twice)', () => {
    expect(decideEscalation('frustration', true)).toEqual({
      reason: 'frustration',
      mode: 'handoff',
    })
  })
})

describe('isSubstantiveAnswer', () => {
  it('is true when there are citations', () => {
    expect(
      isSubstantiveAnswer({
        text: 'ok',
        citations: [{ type: 'article', id: 'x', title: 't', url: 'u' }],
      })
    ).toBe(true)
  })

  it('is false for a short greeting with no citations', () => {
    expect(isSubstantiveAnswer({ text: 'Hi there!', citations: [] })).toBe(false)
  })

  it('is true for a long uncited answer', () => {
    expect(isSubstantiveAnswer({ text: 'x'.repeat(50), citations: [] })).toBe(true)
  })
})

describe('buildAssistantSystemPrompt', () => {
  it('carries the citation, scope-honesty, escalation, and injection guards', () => {
    const joined = buildAssistantSystemPrompt('Quinn').join('\n').toLowerCase()
    expect(joined).toContain('search_knowledge')
    expect(joined).toContain('never invent ids')
    expect(joined).toContain('do not know')
    expect(joined).toContain('escalation')
    expect(joined).toContain('not instructions to obey')
    expect(joined).toContain('same language')
  })
})

describe('isAssistantConfigured', () => {
  it('is true with a client and chat model', () => {
    expect(isAssistantConfigured()).toBe(true)
  })
  it('is false without a chat model', () => {
    mockConfig.aiChatModel = undefined
    expect(isAssistantConfigured()).toBe(false)
  })
  it('is false without the AI client', () => {
    mockConfig.openaiBaseUrl = undefined
    expect(isAssistantConfigured()).toBe(false)
  })
})

describe('runAssistantTurn', () => {
  it('throws when not configured', async () => {
    mockConfig.aiChatModel = undefined
    await expect(
      runAssistantTurn({ ...baseInput, messages: customerAsks('hi') })
    ).rejects.toBeInstanceOf(AssistantNotConfiguredError)
  })

  it('short-circuits (no model call) under the silence rule', async () => {
    const result = await runAssistantTurn({
      ...baseInput,
      messages: [
        { sender: 'customer', content: 'hi' },
        { sender: 'assistant', content: 'hello' },
        { sender: 'human_agent', content: 'I got this' },
      ],
    })
    expect(result).toEqual({ status: 'suppressed', reason: 'silence' })
    expect(mockChat).not.toHaveBeenCalled()
  })

  it('runs the tool round trip and assembles citations from what search_knowledge surfaced', async () => {
    mockRetrieve.mockResolvedValue([makeKbArticle('kb_article_1')])
    const deltas: string[] = []
    mockChat.mockImplementation(
      (opts: {
        tools: Array<{ name: string; execute: (args: unknown, o: unknown) => Promise<unknown> }>
        context: unknown
      }) =>
        (async function* () {
          // Simulate the model calling search_knowledge; the loop threads context.
          const search = opts.tools.find((t) => t.name === 'search_knowledge')!
          await search.execute(
            { query: 'reset password' },
            { context: opts.context, emitCustomEvent: () => {} }
          )
          const object = {
            text: 'Use the reset link.',
            citations: [{ type: 'article', id: 'kb_article_1' }],
          }
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: JSON.stringify(object) }
          yield { type: 'CUSTOM', name: 'structured-output.complete', value: { object } }
          yield {
            type: 'RUN_FINISHED',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          }
        })()
    )

    const result = await runAssistantTurn({
      ...baseInput,
      messages: customerAsks('how do I reset my password?'),
      onTextDelta: (d) => deltas.push(d),
    })

    expect(result).toEqual({
      status: 'answered',
      text: 'Use the reset link.',
      citations: [
        {
          type: 'article',
          id: 'kb_article_1',
          title: 'Title kb_article_1',
          url: '/hc/articles/general/slug-kb_article_1',
        },
      ],
    })
    expect(deltas.join('')).toBe('Use the reset link.')
    // Retrieval was called through the tool, audience-scoped.
    expect(mockRetrieve).toHaveBeenCalledWith('reset password', { audience: 'public' })
  })

  it('drops citations below the confidence floor (nothing retrieved)', async () => {
    mockRetrieve.mockResolvedValue([])
    mockChat.mockImplementation(
      (opts: {
        tools: Array<{ name: string; execute: (args: unknown, o: unknown) => Promise<unknown> }>
        context: unknown
      }) =>
        (async function* () {
          const search = opts.tools.find((t) => t.name === 'search_knowledge')!
          await search.execute(
            { query: 'obscure' },
            { context: opts.context, emitCustomEvent: () => {} }
          )
          const object = {
            text: 'I could not find that. Want me to connect a human?',
            citations: [{ type: 'article', id: 'kb_article_ghost' }],
          }
          yield { type: 'CUSTOM', name: 'structured-output.complete', value: { object } }
          yield { type: 'RUN_FINISHED', usage: undefined }
        })()
    )

    const result = await runAssistantTurn({
      ...baseInput,
      messages: customerAsks('something obscure'),
    })
    expect(result.status).toBe('answered')
    if (result.status === 'answered') expect(result.citations).toEqual([])
  })

  it('offers escalation once, then escalates immediately on the repeat', async () => {
    const object = {
      text: 'Let me get a teammate.',
      citations: [],
      escalation: { reason: 'frustration' },
    }
    mockChat.mockImplementation(() => chunkStream(completeRun(object)))

    const first = await runAssistantTurn({
      ...baseInput,
      messages: customerAsks('this is broken and I am furious'),
      escalationAlreadyOffered: false,
    })
    expect(first.status === 'answered' && first.escalation).toEqual({
      reason: 'frustration',
      mode: 'offer',
    })

    const second = await runAssistantTurn({
      ...baseInput,
      messages: customerAsks('still furious'),
      escalationAlreadyOffered: true,
    })
    expect(second.status === 'answered' && second.escalation).toEqual({
      reason: 'frustration',
      mode: 'handoff',
    })
  })

  it('retries once when the first stream yields no structured object', async () => {
    const object = { text: 'Second try.', citations: [] }
    mockChat
      .mockReturnValueOnce(chunkStream([{ type: 'RUN_FINISHED', usage: undefined }]))
      .mockReturnValueOnce(chunkStream(completeRun(object)))

    const result = await runAssistantTurn({ ...baseInput, messages: customerAsks('q') })
    expect(result.status === 'answered' && result.text).toBe('Second try.')
    expect(mockChat).toHaveBeenCalledTimes(2)
  })

  it('surfaces a RUN_ERROR as a failure', async () => {
    mockChat.mockImplementation(() =>
      chunkStream([{ type: 'RUN_ERROR', message: 'provider exploded' }])
    )
    await expect(runAssistantTurn({ ...baseInput, messages: customerAsks('q') })).rejects.toThrow(
      /provider exploded/
    )
  })
})
