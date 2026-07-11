import { describe, it, expect } from 'vitest'
import {
  DEFAULT_FEATURE_FLAGS,
  LAB_SECTIONS,
  FEATURE_FLAG_REGISTRY,
  LEGACY_FLAG_MAP,
  resolveFeatureFlags,
} from '../settings.types'

describe('LAB_SECTIONS', () => {
  it('surfaces every feature flag exactly once (as a row or a sub-flag)', () => {
    const surfaced = LAB_SECTIONS.flatMap((s) =>
      s.flags.flatMap((row) => [row.key, ...(row.subFlags ?? [])])
    )
    // No flag appears twice...
    expect(new Set(surfaced).size).toBe(surfaced.length)
    // ...and the set of surfaced flags is exactly the full flag set, so a new
    // flag can never silently go unsurfaced on the Labs page.
    expect([...surfaced].sort()).toEqual(Object.keys(DEFAULT_FEATURE_FLAGS).sort())
  })

  it('only references flags that exist in the registry', () => {
    for (const section of LAB_SECTIONS) {
      for (const row of section.flags) {
        expect(FEATURE_FLAG_REGISTRY[row.key]).toBeDefined()
        for (const sub of row.subFlags ?? []) {
          expect(FEATURE_FLAG_REGISTRY[sub]).toBeDefined()
        }
      }
    }
  })
})

describe('resolveFeatureFlags', () => {
  it('returns defaults for a null row', () => {
    expect(resolveFeatureFlags(null)).toEqual(DEFAULT_FEATURE_FLAGS)
  })

  it('keeps stored values for current keys and drops unknown keys', () => {
    const flags = resolveFeatureFlags(JSON.stringify({ helpCenter: false, notAFlag: true }))
    expect(flags.helpCenter).toBe(false)
    expect(flags).not.toHaveProperty('notAFlag')
    expect(Object.keys(flags).sort()).toEqual(Object.keys(DEFAULT_FEATURE_FLAGS).sort())
  })

  it('coalesces every legacy key into its umbrella flag', () => {
    for (const [legacyKey, umbrella] of Object.entries(LEGACY_FLAG_MAP)) {
      const on = resolveFeatureFlags(JSON.stringify({ [legacyKey]: true }))
      expect(on[umbrella], `${legacyKey} -> ${umbrella}`).toBe(true)
      const off = resolveFeatureFlags(JSON.stringify({ [legacyKey]: false }))
      expect(off[umbrella], `${legacyKey} (false) -> ${umbrella}`).toBe(false)
    }
  })

  it('lets an explicit umbrella value win over legacy keys', () => {
    const flags = resolveFeatureFlags(JSON.stringify({ inboxAi: false, assistantCopilot: true }))
    expect(flags.inboxAi).toBe(false)
  })

  it('does not resurrect a disabled inbox from a stored linkPreviews value', () => {
    const flags = resolveFeatureFlags(JSON.stringify({ supportInbox: false, linkPreviews: true }))
    expect(flags.supportInbox).toBe(false)
  })
})
