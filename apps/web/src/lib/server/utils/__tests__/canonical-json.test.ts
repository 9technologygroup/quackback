import { describe, expect, it } from 'vitest'
import { canonicalJson, digestOf } from '../canonical-json'

describe('canonical JSON digests', () => {
  it('ignores key order at every depth', () => {
    expect(digestOf({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      digestOf({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 })
    )
  })

  it('hashes a value the same before and after a JSON round trip', () => {
    const value = { a: undefined, b: 'x', c: [1, 2] }
    expect(digestOf(value)).toBe(digestOf(JSON.parse(JSON.stringify(value))))
    expect(canonicalJson(value)).toBe('{"b":"x","c":[1,2]}')
  })

  it('tells different values apart', () => {
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: '1' }))
    expect(digestOf([1, 2])).not.toBe(digestOf([2, 1]))
  })

  it('refuses a value deep enough to be cyclic', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => digestOf(cyclic)).toThrow(RangeError)
  })
})
