import { describe, it, expect } from 'vitest'
import { renderTemplate } from '../connector.render'

describe('renderTemplate', () => {
  describe('encoding matrix', () => {
    it('uri-encodes special characters for the url position', () => {
      expect(
        renderTemplate('https://api.example.com/search?q={query}', { query: 'a b&c' }, { encode: 'uri' })
      ).toBe('https://api.example.com/search?q=a%20b%26c')
    })

    it('json-escapes quotes and backslashes for the body position', () => {
      expect(
        renderTemplate('{"note": "{note}"}', { note: 'she said "hi"\\ok' }, { encode: 'json' })
      ).toBe('{"note": "she said \\"hi\\"\\\\ok"}')
    })

    it('inserts raw for the header position, with no escaping', () => {
      expect(renderTemplate('Bearer {token}', { token: 'a b&c"d' }, { encode: 'raw' })).toBe(
        'Bearer a b&c"d'
      )
    })

    it('stringifies numbers and booleans before encoding', () => {
      expect(renderTemplate('n={n}&b={b}', { n: 42, b: true }, { encode: 'uri' })).toBe('n=42&b=true')
    })
  })

  describe('unknown tokens', () => {
    it('renders an undeclared token as empty string', () => {
      expect(renderTemplate('id={id}', {}, { encode: 'uri' })).toBe('id=')
    })

    it('renders a token with a null value as empty string', () => {
      expect(
        renderTemplate('id={id}', { id: null as unknown as string }, { encode: 'uri' })
      ).toBe('id=')
    })

    it('does not support fallback syntax — a pipe is outside the token pattern, so it is left verbatim', () => {
      expect(renderTemplate('{id|default}', {}, { encode: 'raw' })).toBe('{id|default}')
    })

    it('leaves non-token braces alone when there is no match', () => {
      expect(renderTemplate('{{not a token}}', {}, { encode: 'raw' })).toBe('{{not a token}}')
    })
  })

  describe('builtin resolution', () => {
    it('resolves dotted builtin tokens like customer.email and conversation.id', () => {
      const out = renderTemplate(
        '{"email":"{customer.email}","name":"{customer.name}","conversationId":"{conversation.id}"}',
        { 'customer.email': 'a@b.com', 'customer.name': 'Ann', 'conversation.id': 'conversation_1' },
        { encode: 'json' }
      )
      expect(out).toBe(
        '{"email":"a@b.com","name":"Ann","conversationId":"conversation_1"}'
      )
    })

    it('renders a builtin absent from values as empty, same as any other unknown token', () => {
      expect(
        renderTemplate('{customer.email}', {}, { encode: 'raw' })
      ).toBe('')
    })
  })

  describe('purity', () => {
    it('returns the same output for the same input and never mutates the values object', () => {
      const values = { id: '42' }
      const snapshot = { ...values }
      const first = renderTemplate('id={id}', values, { encode: 'uri' })
      const second = renderTemplate('id={id}', values, { encode: 'uri' })
      expect(first).toBe(second)
      expect(values).toEqual(snapshot)
    })
  })
})
