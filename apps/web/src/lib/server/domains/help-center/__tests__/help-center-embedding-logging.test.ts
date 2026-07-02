import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockEmbeddingsCreate = vi.fn()
const mockWithUsageLogging = vi.fn()

vi.mock('@/lib/server/domains/ai/config', () => ({
  getOpenAI: vi.fn(() => ({ embeddings: { create: mockEmbeddingsCreate } })),
}))

vi.mock('@/lib/server/domains/ai/models', () => ({
  getEmbeddingModel: vi.fn(() => 'text-embedding-3-small'),
}))

vi.mock('@/lib/server/domains/ai/usage-log', () => ({
  withUsageLogging: (...args: unknown[]) => mockWithUsageLogging(...args),
}))

vi.mock('@/lib/server/db', () => ({
  db: {},
  helpCenterArticles: {},
  eq: vi.fn(),
  sql: vi.fn(),
}))

import { generateKbEmbedding } from '../help-center-embedding.service'

beforeEach(() => {
  vi.clearAllMocks()
  // Pass through: run the wrapped call and extract usage like the real helper.
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
  mockEmbeddingsCreate.mockResolvedValue({
    data: [{ embedding: [0.1, 0.2] }],
    usage: { prompt_tokens: 7, total_tokens: 7 },
  })
})

describe('generateKbEmbedding usage logging', () => {
  it('routes the embedding call through withUsageLogging with the given context', async () => {
    const result = await generateKbEmbedding('some text', {
      pipelineStep: 'kb_article_embedding',
      metadata: { kbArticleId: 'kb_article_1' },
    })

    expect(result).toEqual([0.1, 0.2])
    expect(mockWithUsageLogging).toHaveBeenCalledOnce()
    const [params] = mockWithUsageLogging.mock.calls[0]
    expect(params).toMatchObject({
      pipelineStep: 'kb_article_embedding',
      callType: 'embedding',
      model: 'text-embedding-3-small',
      metadata: { kbArticleId: 'kb_article_1' },
    })
  })

  it('defaults the pipeline step when no context is given', async () => {
    await generateKbEmbedding('some text')
    const [params] = mockWithUsageLogging.mock.calls[0]
    expect(params).toMatchObject({ pipelineStep: 'kb_embedding', callType: 'embedding' })
  })

  it('extracts token usage from the embeddings response', async () => {
    let extracted: unknown
    mockWithUsageLogging.mockImplementation(
      async (
        _params: unknown,
        fn: () => Promise<{ result: unknown; retryCount: number }>,
        extract: (result: unknown) => unknown
      ) => {
        const { result } = await fn()
        extracted = extract(result)
        return result
      }
    )

    await generateKbEmbedding('some text')
    expect(extracted).toEqual({ inputTokens: 7, totalTokens: 7 })
  })

  it('still returns null on API failure', async () => {
    mockWithUsageLogging.mockRejectedValue(new Error('boom'))
    const result = await generateKbEmbedding('some text')
    expect(result).toBeNull()
  })
})
