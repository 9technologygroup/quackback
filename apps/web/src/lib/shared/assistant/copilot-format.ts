/**
 * Pure text helpers for the Copilot panel's P2-C features (COPILOT-SIDEBAR-UX.md
 * "What P2-C adds"): saving an answer as a macro (C.2) and the Summarize chip
 * (C.3, manual half). Isomorphic: no client- or server-only imports, so the
 * server fn and the panel component can share the same formatting rules.
 */

// Mirrors ask-ai-text.ts's INLINE_RE citation-marker pattern (`[n]`), the
// numbered dots the answer card renders inline. A macro body has no citation
// list to resolve them against, so they're stripped rather than carried over.
const CITATION_MARKER_RE = /[ \t]*\[\d+\]/g

/**
 * Strip inline `[n]` citation markers from an answer's plain text (e.g. before
 * saving it as a reusable macro body). Consumes a leading space with the
 * marker so removing it never leaves a double space or a stray space before
 * punctuation, and collapses any incidental run of spaces/tabs left behind.
 * Leaves newlines untouched, so multi-line/list formatting survives.
 */
export function stripCitationMarkers(text: string): string {
  return text
    .replace(CITATION_MARKER_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * Format an on-demand conversation summary (P2-C.3's Summarize chip) as the
 * plain-text "Question / Summary" block Fin writes into the note composer
 * (COPILOT-SIDEBAR-UX.md screenshot 20). Inserted verbatim through the
 * existing note-insert seam; no markdown rendering is assumed downstream.
 */
export function formatConversationSummaryNote(question: string, bullets: string[]): string {
  const bulletLines = bullets.map((bullet) => `- ${bullet}`).join('\n')
  return `Question\n${question}\n\nSummary\n${bulletLines}`
}
