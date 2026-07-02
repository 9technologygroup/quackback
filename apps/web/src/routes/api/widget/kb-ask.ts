/**
 * Ask AI endpoint: streams a synthesized, cited answer built only from
 * published help-center articles.
 *
 * Same public envelope as kb-search (feature gate + CORS *), plus the
 * helpCenterAiAnswers flag, a per-IP rate limit, and a query length cap.
 * The response is SSE with the versioned kb-ask.v1.* events; names and
 * payload shapes live in the shared contract module
 * (lib/shared/help-center/kb-ask-contract.ts), imported by this route and
 * the Ask AI client.
 *
 * Requests without a `q` act as a capability probe so public surfaces can
 * hide the affordance when AI is not configured.
 */
import { createFileRoute } from '@tanstack/react-router'
import { getFeatureFlags } from '@/lib/server/domains/settings/settings.service'
import {
  retrieveKbArticles,
  synthesizeAnswer,
  isAskAiConfigured,
} from '@/lib/server/domains/assistant'
import {
  KB_ASK_EVENTS,
  type KbAskErrorPayload,
  type KbAskFinalPayload,
  type KbAskSourcesPayload,
} from '@/lib/shared/help-center/kb-ask-contract'
import {
  enforcePerIpLimit,
  widgetCorsHeaders,
  widgetJsonError,
} from '@/lib/server/widget/public-endpoint'
import { createSseStream, SSE_RESPONSE_HEADERS } from '@/lib/server/utils/sse'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'widget-kb-ask' })

export const KB_ASK_MAX_QUERY_CHARS = 500
export const KB_ASK_RATE_LIMIT = 10
const RATE_WINDOW_SECONDS = 60

const NO_ANSWER: KbAskFinalPayload = { answer: null, sources: [] }

export async function handleKbAsk({ request }: { request: Request }): Promise<Response> {
  const flags = await getFeatureFlags()
  if (!flags.helpCenter || !flags.helpCenterAiAnswers) {
    return widgetJsonError(404, 'NOT_FOUND', 'Knowledge base not found')
  }

  const url = new URL(request.url)
  const rawQuery = url.searchParams.get('q')

  // Capability probe: lets clients hide the Ask AI affordance when no model
  // is configured, without exposing any configuration detail.
  if (rawQuery === null) {
    return Response.json(
      { data: { enabled: isAskAiConfigured() } },
      { headers: widgetCorsHeaders() }
    )
  }

  const query = rawQuery.trim()
  if (!query) {
    return widgetJsonError(400, 'INVALID_QUERY', 'Query must not be empty')
  }
  if (query.length > KB_ASK_MAX_QUERY_CHARS) {
    return widgetJsonError(
      413,
      'QUERY_TOO_LONG',
      `Query exceeds ${KB_ASK_MAX_QUERY_CHARS} characters`
    )
  }

  // Configuration is a sync check: refuse before spending a Redis round-trip
  // on rate limiting requests that could never be answered.
  if (!isAskAiConfigured()) {
    return widgetJsonError(503, 'AI_NOT_CONFIGURED', 'AI answers are not configured')
  }

  const limited = await enforcePerIpLimit(request, {
    keyPrefix: 'kbask',
    limit: KB_ASK_RATE_LIMIT,
    windowSeconds: RATE_WINDOW_SECONDS,
    message: 'Too many questions, slow down',
  })
  if (limited) return limited

  let articles
  try {
    articles = await retrieveKbArticles(query, { audience: 'public' })
  } catch (error) {
    log.error({ err: error }, 'kb ask retrieval failed')
    return widgetJsonError(500, 'SERVER_ERROR', 'Answer lookup failed')
  }

  const sse = createSseStream()

  void (async () => {
    try {
      // Nothing cleared the similarity floor: honest no-answer, zero model
      // spend.
      if (articles.length === 0) {
        sse.send(KB_ASK_EVENTS.final, NO_ANSWER)
        return
      }

      sse.send(KB_ASK_EVENTS.sources, {
        sources: articles.map((a) => ({
          articleId: a.id,
          title: a.title,
          slug: a.slug,
          categorySlug: a.categorySlug,
          categoryName: a.categoryName,
        })),
      } satisfies KbAskSourcesPayload)

      const result = await synthesizeAnswer({
        query,
        articles,
        signal: request.signal,
        onAnswerDelta: (text) => sse.send(KB_ASK_EVENTS.delta, { text }),
      })

      if (result.answer.trim()) {
        sse.send(KB_ASK_EVENTS.final, {
          answer: result.answer,
          sources: result.sources,
        } satisfies KbAskFinalPayload)
      } else {
        sse.send(KB_ASK_EVENTS.final, NO_ANSWER)
      }
    } catch (error) {
      if (!request.signal.aborted) {
        log.error({ err: error }, 'kb ask synthesis failed')
        sse.send(KB_ASK_EVENTS.error, {
          code: 'SYNTHESIS_FAILED',
          message: 'Answer generation failed',
        } satisfies KbAskErrorPayload)
      }
    } finally {
      sse.close()
    }
  })()

  return new Response(sse.stream, {
    headers: { ...widgetCorsHeaders(), ...SSE_RESPONSE_HEADERS },
  })
}

export const Route = createFileRoute('/api/widget/kb-ask')({
  server: {
    handlers: {
      GET: handleKbAsk,
    },
  },
})
