/**
 * Auto-translate (domains/languages §H3, fast-follow). On publish of a
 * base-locale article, when helpCenterConfig.autoTranslate.enabled, one job
 * per enabled additional locale is queued through the existing feedback-ai
 * BullMQ queue (a second dedicated worker for one more rate-limit-sensitive
 * OpenAI-compatible call isn't warranted). The job translates the article
 * via the BYOK AI client and writes the result as a DRAFT translation --
 * never auto-published -- so a human always reviews before it goes live.
 */
import { getOpenAI, stripCodeFences } from '@/lib/server/domains/ai/config'
import { getChatModel } from '@/lib/server/domains/ai/models'
import { withRetry } from '@/lib/server/domains/ai/retry'
import { withUsageLogging } from '@/lib/server/domains/ai/usage-log'
import { markdownToTiptapJson } from '@/lib/server/markdown-tiptap'
import { getHelpCenterConfig } from '@/lib/server/domains/settings/settings.service'
import { getArticleById } from './help-center.article.service'
import { upsertArticleTranslation } from './help-center-translations.service'
import { logger } from '@/lib/server/logger'
import type { KbArticleId } from '@quackback/ids'
import type { HelpCenterArticleWithCategory } from './help-center.types'

const log = logger.child({ component: 'help-center-auto-translate' })

interface TranslationResult {
  title: string
  description: string
  content: string
}

/**
 * Builds the chat messages for a translation call. Pure so the prompt shape
 * (protected-terms instruction, JSON contract) is unit-testable without a
 * live AI client.
 */
export function buildTranslationPrompt(input: {
  title: string
  description: string | null
  content: string
  locale: string
  protectedTerms: string[]
}): { system: string; user: string } {
  const glossaryLine =
    input.protectedTerms.length > 0
      ? `\n\nNever translate these terms; keep them exactly as written: ${input.protectedTerms.join(', ')}.`
      : ''

  const system = `You are a professional technical translator localizing help-center articles.
Translate the given title, description, and Markdown content into the locale "${input.locale}".
Preserve all Markdown formatting (headings, lists, links, code blocks) exactly -- translate
only the human-readable text, never code, URLs, or Markdown syntax.${glossaryLine}

Return strict JSON only:
{
  "title": "string",
  "description": "string",
  "content": "string"
}`

  const user = JSON.stringify({
    title: input.title,
    description: input.description ?? '',
    content: input.content,
  })

  return { system, user }
}

/** The job handler: translate one article into one locale, write a draft. */
export async function translateArticleForLocale(
  articleId: KbArticleId,
  locale: string
): Promise<void> {
  const openai = getOpenAI()
  const model = getChatModel('helpCenterTranslate')
  if (!openai || !model) {
    log.debug({ article_id: articleId, locale }, 'auto-translate skipped: AI not configured')
    return
  }

  const config = await getHelpCenterConfig()
  const protectedTerms = config.autoTranslate?.protectedTerms ?? []

  const article = await getArticleById(articleId)
  const { system, user } = buildTranslationPrompt({
    title: article.title,
    description: article.description,
    content: article.content,
    locale,
    protectedTerms,
  })

  const completion = await withUsageLogging(
    {
      pipelineStep: 'help_center_translate',
      callType: 'chat_completion',
      model,
      metadata: { articleId, locale },
    },
    () =>
      withRetry(() =>
        openai.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
        })
      ),
    (result) => ({
      inputTokens: result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.completion_tokens ?? 0,
      totalTokens: result.usage?.total_tokens ?? 0,
    })
  )

  const raw = completion.choices[0]?.message?.content
  if (!raw) {
    log.error({ article_id: articleId, locale }, 'auto-translate: empty AI response')
    return
  }

  let parsed: TranslationResult
  try {
    parsed = JSON.parse(stripCodeFences(raw)) as TranslationResult
  } catch (err) {
    log.error({ err, article_id: articleId, locale }, 'auto-translate: unparseable AI response')
    return
  }
  if (!parsed.title || !parsed.content) {
    log.error({ article_id: articleId, locale }, 'auto-translate: incomplete AI response')
    return
  }

  await upsertArticleTranslation({
    articleId,
    locale,
    title: parsed.title,
    description: parsed.description || undefined,
    content: parsed.content,
    contentJson: markdownToTiptapJson(parsed.content),
  })
  log.info({ article_id: articleId, locale }, 'auto-translate: draft translation written')
}

/**
 * Called from publishArticle(). Fire-and-forget from the caller's
 * perspective -- enqueuing failures are logged, not thrown, so a translation
 * outage never blocks publishing the base article.
 */
export async function queueAutoTranslateOnPublish(
  article: HelpCenterArticleWithCategory
): Promise<void> {
  try {
    const config = await getHelpCenterConfig()
    if (!config.autoTranslate?.enabled) return
    const additionalLocales = config.locales?.additional ?? []
    if (additionalLocales.length === 0) return

    const { enqueueFeedbackAiJob } = await import(
      '@/lib/server/domains/feedback/queues/feedback-ai-queue'
    )
    await Promise.all(
      additionalLocales.map((locale) =>
        enqueueFeedbackAiJob({
          type: 'help-center-translate-article',
          articleId: article.id,
          locale,
        })
      )
    )
  } catch (err) {
    log.error({ err, article_id: article.id }, 'failed to queue auto-translate jobs')
  }
}
