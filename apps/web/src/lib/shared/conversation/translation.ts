/**
 * P2-D.1 two-way inbox translation: the client-detectable shape of a blocked
 * outgoing send. Mirrors attribute-values.ts's
 * MISSING_REQUIRED_ATTRIBUTES_PREFIX / isMissingRequiredAttributesMessage
 * pattern — the server's TranslationUnavailableError message and this
 * predicate share one constant so they can never drift, letting the composer
 * distinguish "translation failed, offer Send untranslated" from any other
 * send error without a dedicated error-code channel.
 */

/** The server-side TranslationUnavailableError's message (verbatim). */
export const TRANSLATION_UNAVAILABLE_MESSAGE = 'Translation is unavailable right now.'

/** True when a send failed specifically because translation could not
 *  complete — the composer should offer "Send untranslated" rather than a
 *  generic failure toast. */
export function isTranslationUnavailableMessage(message: string | null | undefined): boolean {
  return !!message?.includes(TRANSLATION_UNAVAILABLE_MESSAGE)
}

/**
 * Per-message translation display, shared between the client hook that
 * resolves it (use-inbox-translation.ts) and the bubble that renders it
 * (message-bubble.tsx) — lives here rather than on the component so `lib/`
 * never has to import from `components/`.
 */
export interface MessageTranslationDisplay {
  /** Direction-aware toggle label, e.g. "Translated from French" (incoming)
   *  or "Translated to French" (outgoing) — built by the caller, which knows
   *  the direction; the bubble only appends the "Show original"/"Show
   *  translation" action. */
  label: string
  translatedContent: string
  originalContent: string
  showingOriginal: boolean
  onToggleOriginal: () => void
}
