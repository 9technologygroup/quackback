/**
 * Pure text helpers for the Ask AI surfaces: query-term highlighting for
 * autocomplete results and a markdown-lite parser (paragraphs, bullets,
 * bold) for AI answers. Both return data structures rendered as React text
 * nodes, so there is no HTML injection surface.
 */

export interface TermSegment {
  text: string
  match: boolean
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Split text into segments, marking case-insensitive occurrences of the
 * query's terms. Single-character terms are ignored as noise. The query is
 * regex-escaped, so user input cannot inject patterns.
 */
export function splitByTerms(text: string, query: string): TermSegment[] {
  const terms = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
  if (terms.length === 0 || !text) return [{ text, match: false }]

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi')
  const parts = text.split(pattern)
  const segments: TermSegment[] = []
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue
    // String.split with a capturing group interleaves matches at odd indexes.
    segments.push({ text: parts[i], match: i % 2 === 1 })
  }
  return segments.length > 0 ? segments : [{ text, match: false }]
}

export interface InlineSpan {
  text: string
  bold: boolean
}

export type MarkdownLiteBlock =
  | { kind: 'paragraph'; lines: InlineSpan[][] }
  | { kind: 'list'; items: InlineSpan[][] }

/** Parse `**bold**` spans within a single line. */
function parseInline(line: string): InlineSpan[] {
  const parts = line.split(/\*\*([^*]+)\*\*/)
  const spans: InlineSpan[] = []
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue
    spans.push({ text: parts[i], bold: i % 2 === 1 })
  }
  return spans.length > 0 ? spans : [{ text: '', bold: false }]
}

const BULLET_RE = /^\s*[-*•]\s+/

/**
 * Parse answer text into paragraph and bullet-list blocks. Only the
 * structures AI answers are instructed to use (paragraphs, bullets, bold)
 * are recognized; anything else stays literal text.
 */
export function parseMarkdownLite(text: string): MarkdownLiteBlock[] {
  const blocks: MarkdownLiteBlock[] = []
  for (const raw of text.split(/\n{2,}/)) {
    const blockText = raw.trim()
    if (!blockText) continue
    const lines = blockText.split('\n').filter((l) => l.trim().length > 0)

    const bulletLines = lines.filter((l) => BULLET_RE.test(l))
    if (bulletLines.length === lines.length && lines.length > 0) {
      blocks.push({
        kind: 'list',
        items: lines.map((l) => parseInline(l.replace(BULLET_RE, '').trim())),
      })
      continue
    }
    blocks.push({ kind: 'paragraph', lines: lines.map((l) => parseInline(l.trim())) })
  }
  return blocks
}
