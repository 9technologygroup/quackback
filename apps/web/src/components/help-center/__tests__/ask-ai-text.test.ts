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
        items: [[{ text: 'one', bold: false }], [{ text: 'two', bold: false }]],
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
