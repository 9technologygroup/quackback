/**
 * The kb-ask.v1 SSE contract, shared by the server route (emit) and the Ask
 * AI client (consume). Client-safe: names and payload types only.
 *
 * The event vocabulary is a public contract, so additions must come as new
 * names (or a v2), never as silent shape changes.
 */

export const KB_ASK_EVENTS = {
  sources: 'kb-ask.v1.sources',
  delta: 'kb-ask.v1.delta',
  final: 'kb-ask.v1.final',
  error: 'kb-ask.v1.error',
} as const

/** Display metadata for one retrieved article, sent before synthesis starts. */
export interface KbAskSourceMeta {
  articleId: string
  title: string
  slug: string
  categorySlug: string
  categoryName: string
}

/** kb-ask.v1.sources: the articles the answer will be built from. */
export interface KbAskSourcesPayload {
  sources: KbAskSourceMeta[]
}

/** kb-ask.v1.delta: one fragment of the streamed answer text. */
export interface KbAskDeltaPayload {
  text: string
}

/** kb-ask.v1.final: the validated answer, or null for an honest no-answer. */
export interface KbAskFinalPayload {
  answer: string | null
  sources: Array<{ articleId: string }>
}

/** kb-ask.v1.error: a terminal failure after the stream opened. */
export interface KbAskErrorPayload {
  code: string
  message: string
}
