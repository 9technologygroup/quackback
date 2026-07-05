import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { KbArticleId } from '@quackback/ids'

const mockGetOpenAI = vi.fn()
const mockGetChatModel = vi.fn()
const mockGetHelpCenterConfig = vi.fn()
const mockGetArticleById = vi.fn()
const mockUpsertArticleTranslation = vi.fn()
const mockEnqueueFeedbackAiJob = vi.fn()
const mockCreate = vi.fn()

vi.mock('@/lib/server/domains/ai/config', () => ({
  getOpenAI: () => mockGetOpenAI(),
  stripCodeFences: (s: string) => s.replace(/```json\n?|```/g, ''),
}))
vi.mock('@/lib/server/domains/ai/models', () => ({
  getChatModel: (...args: unknown[]) => mockGetChatModel(...args),
}))
vi.mock('@/lib/server/domains/ai/retry', () => ({
  withRetry: async (fn: () => Promise<unknown>) => ({ result: await fn(), retryCount: 0 }),
}))
vi.mock('@/lib/server/domains/ai/usage-log', () => ({
  withUsageLogging: async (
    _params: unknown,
    fn: () => Promise<{ result: unknown; retryCount: number }>
  ) => (await fn()).result,
}))
vi.mock('@/lib/server/markdown-tiptap', () => ({
  markdownToTiptapJson: (md: string) => ({ type: 'doc', content: [{ type: 'text', text: md }] }),
}))
vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  getHelpCenterConfig: () => mockGetHelpCenterConfig(),
}))
vi.mock('../help-center.article.service', () => ({
  getArticleById: (...args: unknown[]) => mockGetArticleById(...args),
}))
vi.mock('../help-center-translations.service', () => ({
  upsertArticleTranslation: (...args: unknown[]) => mockUpsertArticleTranslation(...args),
}))
vi.mock('@/lib/server/domains/feedback/queues/feedback-ai-queue', () => ({
  enqueueFeedbackAiJob: (...args: unknown[]) => mockEnqueueFeedbackAiJob(...args),
}))

const { buildTranslationPrompt, translateArticleForLocale, queueAutoTranslateOnPublish } =
  await import('../help-center-auto-translate.service')

beforeEach(() => {
  mockGetOpenAI.mockReset()
  mockGetChatModel.mockReset()
  mockGetHelpCenterConfig.mockReset()
  mockGetArticleById.mockReset()
  mockUpsertArticleTranslation.mockReset()
  mockEnqueueFeedbackAiJob.mockReset()
  mockCreate.mockReset()
})

describe('buildTranslationPrompt', () => {
  it('includes the target locale and a strict JSON contract', () => {
    const { system } = buildTranslationPrompt({
      title: 'Refunds',
      description: null,
      content: '# Refunds\n\nHow to request one.',
      locale: 'de',
      protectedTerms: [],
    })
    expect(system).toContain('"de"')
    expect(system).toContain('"title"')
    expect(system).toContain('"content"')
  })

  it('instructs the model never to translate protected terms', () => {
    const { system } = buildTranslationPrompt({
      title: 'Refunds',
      description: null,
      content: 'Contact Quackback support.',
      locale: 'de',
      protectedTerms: ['Quackback', 'API'],
    })
    expect(system).toContain('Quackback, API')
    expect(system).toMatch(/never translate/i)
  })

  it('omits the glossary instruction when there are no protected terms', () => {
    const { system } = buildTranslationPrompt({
      title: 'Refunds',
      description: null,
      content: 'x',
      locale: 'de',
      protectedTerms: [],
    })
    expect(system).not.toMatch(/never translate/i)
  })

  it('carries the source content through as the user message', () => {
    const { user } = buildTranslationPrompt({
      title: 'Refunds',
      description: 'How to get one',
      content: 'Body text',
      locale: 'fr',
      protectedTerms: [],
    })
    const parsed = JSON.parse(user)
    expect(parsed).toEqual({ title: 'Refunds', description: 'How to get one', content: 'Body text' })
  })
})

describe('translateArticleForLocale', () => {
  it('no-ops silently when AI is not configured', async () => {
    mockGetOpenAI.mockReturnValue(null)
    mockGetChatModel.mockReturnValue(null)

    await translateArticleForLocale('kb_article_1' as KbArticleId, 'de')

    expect(mockGetArticleById).not.toHaveBeenCalled()
    expect(mockUpsertArticleTranslation).not.toHaveBeenCalled()
  })

  it('writes a draft translation from the AI response', async () => {
    mockGetOpenAI.mockReturnValue({ chat: { completions: { create: mockCreate } } })
    mockGetChatModel.mockReturnValue('gpt-test')
    mockGetHelpCenterConfig.mockResolvedValue({ autoTranslate: { protectedTerms: ['Quackback'] } })
    mockGetArticleById.mockResolvedValue({
      title: 'Refunds',
      description: 'How to get one',
      content: 'Contact Quackback support.',
    })
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: 'Rückerstattungen',
              description: 'Wie man eine bekommt',
              content: 'Kontaktieren Sie den Quackback-Support.',
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    })

    await translateArticleForLocale('kb_article_1' as KbArticleId, 'de')

    expect(mockUpsertArticleTranslation).toHaveBeenCalledWith(
      expect.objectContaining({
        articleId: 'kb_article_1',
        locale: 'de',
        title: 'Rückerstattungen',
        description: 'Wie man eine bekommt',
        content: 'Kontaktieren Sie den Quackback-Support.',
      })
    )
  })

  it('does not throw and does not write when the AI response is unparseable', async () => {
    mockGetOpenAI.mockReturnValue({ chat: { completions: { create: mockCreate } } })
    mockGetChatModel.mockReturnValue('gpt-test')
    mockGetHelpCenterConfig.mockResolvedValue({ autoTranslate: { protectedTerms: [] } })
    mockGetArticleById.mockResolvedValue({ title: 'Refunds', description: null, content: 'x' })
    mockCreate.mockResolvedValue({ choices: [{ message: { content: 'not json' } }] })

    await expect(translateArticleForLocale('kb_article_1' as KbArticleId, 'de')).resolves.toBeUndefined()
    expect(mockUpsertArticleTranslation).not.toHaveBeenCalled()
  })
})

describe('queueAutoTranslateOnPublish', () => {
  it('does nothing when auto-translate is disabled', async () => {
    mockGetHelpCenterConfig.mockResolvedValue({
      autoTranslate: { enabled: false },
      locales: { additional: ['de', 'fr'] },
    })

    await queueAutoTranslateOnPublish({ id: 'kb_article_1' } as never)

    expect(mockEnqueueFeedbackAiJob).not.toHaveBeenCalled()
  })

  it('does nothing when no additional locale is enabled', async () => {
    mockGetHelpCenterConfig.mockResolvedValue({
      autoTranslate: { enabled: true },
      locales: { additional: [] },
    })

    await queueAutoTranslateOnPublish({ id: 'kb_article_1' } as never)

    expect(mockEnqueueFeedbackAiJob).not.toHaveBeenCalled()
  })

  it('queues one job per enabled additional locale', async () => {
    mockGetHelpCenterConfig.mockResolvedValue({
      autoTranslate: { enabled: true },
      locales: { additional: ['de', 'fr'] },
    })

    await queueAutoTranslateOnPublish({ id: 'kb_article_1' } as never)

    expect(mockEnqueueFeedbackAiJob).toHaveBeenCalledTimes(2)
    expect(mockEnqueueFeedbackAiJob).toHaveBeenCalledWith({
      type: 'help-center-translate-article',
      articleId: 'kb_article_1',
      locale: 'de',
    })
    expect(mockEnqueueFeedbackAiJob).toHaveBeenCalledWith({
      type: 'help-center-translate-article',
      articleId: 'kb_article_1',
      locale: 'fr',
    })
  })

  it('swallows enqueue errors rather than throwing (never blocks publish)', async () => {
    mockGetHelpCenterConfig.mockRejectedValue(new Error('settings unavailable'))

    await expect(queueAutoTranslateOnPublish({ id: 'kb_article_1' } as never)).resolves.toBeUndefined()
  })
})
