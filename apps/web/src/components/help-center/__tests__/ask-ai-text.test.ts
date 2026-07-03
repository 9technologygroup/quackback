import { describe, it, expect } from 'vitest'
import { splitByTerms, parseMarkdownLite } from '../ask-ai-text'

describe('splitByTerms', () => {
  it('marks case-insensitive term matches', () => {
    expect(splitByTerms('Invite your Team today', 'team invite')).toEqual([
      { text: 'Invite', match: true },
      { text: ' your ', match: false },
      { text: 'Team', match: true },
      { text: ' today', match: false },
    ])
  })

  it('returns the whole text unmarked when the query is empty', () => {
    expect(splitByTerms('Hello world', '   ')).toEqual([{ text: 'Hello world', match: false }])
  })

  it('is safe against regex metacharacters in the query', () => {
    expect(splitByTerms('a+b equals c', 'a+b (')).toEqual([
      { text: 'a+b', match: true },
      { text: ' equals c', match: false },
    ])
  })

  it('ignores single-character noise terms', () => {
    expect(splitByTerms('a big cat', 'a big')).toEqual([
      { text: 'a ', match: false },
      { text: 'big', match: true },
      { text: ' cat', match: false },
    ])
  })
})

describe('parseMarkdownLite', () => {
  it('splits paragraphs on blank lines', () => {
    expect(parseMarkdownLite('First.\n\nSecond.')).toEqual([
      { kind: 'paragraph', lines: [[{ text: 'First.', bold: false }]] },
      { kind: 'paragraph', lines: [[{ text: 'Second.', bold: false }]] },
    ])
  })

  it('parses bullet lists', () => {
    expect(parseMarkdownLite('- one\n- two')).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [[{ text: 'one', bold: false }], [{ text: 'two', bold: false }]],
      },
    ])
  })

  it('parses numbered lists as ordered', () => {
    expect(parseMarkdownLite('1. first\n2. second')).toEqual([
      {
        kind: 'list',
        ordered: true,
        items: [[{ text: 'first', bold: false }], [{ text: 'second', bold: false }]],
      },
    ])
  })

  it('parses bold spans inside text', () => {
    expect(parseMarkdownLite('Use the **Invite member** button.')).toEqual([
      {
        kind: 'paragraph',
        lines: [
          [
            { text: 'Use the ', bold: false },
            { text: 'Invite member', bold: true },
            { text: ' button.', bold: false },
          ],
        ],
      },
    ])
  })

  it('parses [n] citation markers into cite spans', () => {
    expect(parseMarkdownLite('Open Settings [1] then Team [2].')).toEqual([
      {
        kind: 'paragraph',
        lines: [
          [
            { text: 'Open Settings ', bold: false },
            { text: '1', bold: false, cite: 1 },
            { text: ' then Team ', bold: false },
            { text: '2', bold: false, cite: 2 },
            { text: '.', bold: false },
          ],
        ],
      },
    ])
  })

  it('handles a bold label and a citation in the same line', () => {
    expect(parseMarkdownLite('Click **Invite** [3].')).toEqual([
      {
        kind: 'paragraph',
        lines: [
          [
            { text: 'Click ', bold: false },
            { text: 'Invite', bold: true },
            { text: ' ', bold: false },
            { text: '3', bold: false, cite: 3 },
            { text: '.', bold: false },
          ],
        ],
      },
    ])
  })

  it('keeps single newlines as separate lines within a paragraph', () => {
    expect(parseMarkdownLite('line one\nline two')).toEqual([
      {
        kind: 'paragraph',
        lines: [[{ text: 'line one', bold: false }], [{ text: 'line two', bold: false }]],
      },
    ])
  })

  it('treats asterisk bullets like dashes', () => {
    const blocks = parseMarkdownLite('* alpha\n* beta')
    expect(blocks[0].kind).toBe('list')
  })
})
