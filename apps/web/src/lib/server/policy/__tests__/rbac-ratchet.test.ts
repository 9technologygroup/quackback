import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Conversion ratchet (Phase C): the count of remaining legacy role gates
// (`requireAuth({ roles })` server functions + `withApiKeyAuth({ role })` API
// routes) must only ever decrease as each batch converts to a permission gate.
// Lower MAX after every conversion PR; at the completion gate it reaches 0 and
// the `roles` / `role` options are deleted outright (a compile error replaces
// this runtime ratchet).
const MAX_LEGACY_ROLE_GATES = 0 // post-C8 (all requireAuth + withApiKeyAuth role gates converted)

const SRC = join(__dirname, '../../../..') // apps/web/src

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      walk(p, acc)
    } else if ((name.endsWith('.ts') || name.endsWith('.tsx')) && !name.includes('.test.')) {
      acc.push(p)
    }
  }
  return acc
}

function countLegacyRoleGates(): number {
  let n = 0
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8')
    n += (src.match(/requireAuth\(\{\s*roles:/g) ?? []).length
    // Call sites only (an identifier arg before the brace) — not the
    // withApiKeyAuth definition's `options?: { role: ... }` signature.
    n += (src.match(/withApiKeyAuth\(\w+,\s*\{\s*role:/g) ?? []).length
  }
  return n
}

describe('RBAC conversion ratchet', () => {
  it('legacy requireAuth({ roles }) gate count only decreases', () => {
    expect(countLegacyRoleGates()).toBeLessThanOrEqual(MAX_LEGACY_ROLE_GATES)
  })
})
