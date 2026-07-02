/**
 * Help Center Embedding Service
 *
 * Generates embeddings for knowledge base articles using the same
 * configured embedding model as the feedback pipeline.
 */

import { db, helpCenterArticles, eq, sql } from '@/lib/server/db'
import { getOpenAI } from '@/lib/server/domains/ai/config'
import { getEmbeddingModel } from '@/lib/server/domains/ai/models'
import { withRetry } from '@/lib/server/domains/ai/retry'
import { withUsageLogging } from '@/lib/server/domains/ai/usage-log'
import type { KbArticleId } from '@quackback/ids'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'help-center-embedding' })

const KB_EMBEDDING_DIMENSIONS = 1536

/**
 * Format article text for embedding input.
 *
 * Title is repeated twice for emphasis (higher weight in similarity).
 * Category name is appended as context when available.
 * Total output is truncated to 8000 chars to avoid token limits.
 */
export function formatArticleText(title: string, content: string, categoryName?: string): string {
  const parts = [title, title, content || '']
  if (categoryName) parts.push(`Category: ${categoryName}`)
  return parts.join('\n\n').slice(0, 8000)
}

/** Where an embedding call came from, for the ai_usage_log row. */
export interface KbEmbeddingLogContext {
  pipelineStep: string
  metadata?: Record<string, unknown>
}

/**
 * Generate embedding for text using the configured embedding model.
 * Every call is recorded in ai_usage_log under the caller's pipeline step.
 */
export async function generateKbEmbedding(
  text: string,
  logContext?: KbEmbeddingLogContext
): Promise<number[] | null> {
  const openai = getOpenAI()
  const model = getEmbeddingModel()
  if (!openai || !model) return null

  try {
    const response = await withUsageLogging(
      {
        pipelineStep: logContext?.pipelineStep ?? 'kb_embedding',
        callType: 'embedding',
        model,
        metadata: logContext?.metadata,
      },
      () =>
        withRetry(() =>
          openai.embeddings.create({
            model,
            input: text,
            dimensions: KB_EMBEDDING_DIMENSIONS,
          })
        ),
      (result) => ({
        inputTokens: result.usage?.prompt_tokens ?? 0,
        totalTokens: result.usage?.total_tokens ?? 0,
      })
    )
    return response.data[0]?.embedding ?? null
  } catch (error) {
    log.error({ err: error }, 'article embedding generation failed')
    return null
  }
}

/**
 * Generate embedding for an article and save it to the database.
 */
export async function generateArticleEmbedding(
  articleId: string,
  title: string,
  content: string,
  categoryName?: string
): Promise<boolean> {
  const text = formatArticleText(title, content, categoryName)
  const embedding = await generateKbEmbedding(text, {
    pipelineStep: 'kb_article_embedding',
    metadata: { kbArticleId: articleId },
  })
  if (!embedding) return false

  const vectorStr = `[${embedding.join(',')}]`
  await db
    .update(helpCenterArticles)
    .set({
      embedding: sql`${vectorStr}::vector`,
      embeddingModel: getEmbeddingModel() ?? 'unknown',
      embeddingUpdatedAt: new Date(),
    })
    .where(eq(helpCenterArticles.id, articleId as KbArticleId))

  return true
}
