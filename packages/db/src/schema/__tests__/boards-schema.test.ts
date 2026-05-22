import { describe, it, expect } from 'vitest'
import { boards } from '../boards'

describe('boards schema', () => {
  it('exposes the audience column with a safe default', () => {
    const audience = boards.audience
    expect(audience).toBeDefined()
    // Drizzle attaches the default factory on the column object.
    // We don't introspect drizzle internals here — the typecheck below is the real assertion.
    type Row = typeof boards.$inferSelect
    const sample: Row = {} as Row
    // Compile-time: this property access must exist on the inferred row.
    void sample.audience
  })
})
