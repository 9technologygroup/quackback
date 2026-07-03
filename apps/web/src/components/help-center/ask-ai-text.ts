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
  /** 1-based citation number when this span is a `[n]` marker (Wikipedia-style). */
  cite?: number
}

export type MarkdownLiteBlock =
  | { kind: 'paragraph'; lines: InlineSpan[][] }
  | { kind: 'list'; ordered: boolean; items: InlineSpan[][] }

// A bold run (**...**) or a citation marker ([n]); everything else is literal.
const INLINE_RE = /\*\*([^*]+)\*\*|\[(\d+)\]/g

/** Parse `**bold**` runs and `[n]` citation markers within a single line. */
function parseInline(line: string): InlineSpan[] {
  const spans: InlineSpan[] = []
  let last = 0
  for (const m of line.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0
    if (idx > last) spans.push({ text: line.slice(last, idx), bold: false })
    if (m[1] !== undefined) {
      spans.push({ text: m[1], bold: true })
    } else if (m[2] !== undefined) {
      spans.push({ text: m[2], bold: false, cite: Number(m[2]) })
    }
    last = idx + m[0].length
  }
  if (last < line.length) spans.push({ text: line.slice(last), bold: false })
  return spans.length > 0 ? spans : [{ text: '', bold: false }]
}

const BULLET_RE = /^\s*[-*•]\s+/
const ORDERED_RE = /^\s*\d+\.\s+/

/**
 * Parse answer text into paragraph and list blocks. Only the structures AI
 * answers are instructed to use (paragraphs, ordered/bullet lists, bold, and
 * `[n]` citation markers) are recognized; anything else stays literal text.
 * A block is a list only when every one of its lines shares one marker style.
 */
export function parseMarkdownLite(text: string): MarkdownLiteBlock[] {
  const blocks: MarkdownLiteBlock[] = []
  for (const raw of text.split(/\n{2,}/)) {
    const blockText = raw.trim()
    if (!blockText) continue
    const lines = blockText.split('\n').filter((l) => l.trim().length > 0)

    if (lines.length > 0 && lines.every((l) => ORDERED_RE.test(l))) {
      blocks.push({
        kind: 'list',
        ordered: true,
        items: lines.map((l) => parseInline(l.replace(ORDERED_RE, '').trim())),
      })
      continue
    }
    if (lines.length > 0 && lines.every((l) => BULLET_RE.test(l))) {
      blocks.push({
        kind: 'list',
        ordered: false,
        items: lines.map((l) => parseInline(l.replace(BULLET_RE, '').trim())),
      })
      continue
    }
    blocks.push({ kind: 'paragraph', lines: lines.map((l) => parseInline(l.trim())) })
  }
  return blocks
}
