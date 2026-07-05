import { describe, it, expect, vi, beforeEach } from 'vitest'

// Table sentinels + operator stubs; the service passes an explicit `exec`, so
// the mocked `db` is only a fallback and the operators just need to not throw.
const notExistsSpy = vi.fn((q: unknown) => ({ notExists: q }))
// Spread the real db module so tables/operators stay current; override only what this suite drives.
vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: {},
  and: (...a: unknown[]) => ({ and: a }),
  eq: (...a: unknown[]) => ({ eq: a }),
  gt: (...a: unknown[]) => ({ gt: a }),
  lt: (...a: unknown[]) => ({ lt: a }),
  isNull: (...a: unknown[]) => ({ isNull: a }),
  notExists: (q: unknown) => notExistsSpy(q),
  desc: (...a: unknown[]) => ({ desc: a }),
  sql: (strings: TemplateStringsArray) => ({ sql: strings }),
}))

import { finalizeStaleAssistantInvolvements } from '../assistant.involvement'

/**
 * A minimal drizzle-shaped executor: the correlated NOT EXISTS subquery is built
 * via select().from().where() (not awaited), and the sweep's set-based UPDATE
 * resolves through update().set().where().returning() to `resolvedRows`.
 */
function makeExec(resolvedRows: Array<{ id: string }>) {
  return {
    select: () => ({ from: () => ({ where: () => ({ __subquery: true }) }) }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => resolvedRows }) }),
    }),
  } as never
}

beforeEach(() => vi.clearAllMocks())

describe('finalizeStaleAssistantInvolvements', () => {
  it('resolves in one set-based UPDATE, returning the count of rows it flipped', async () => {
    const exec = makeExec([{ id: 'assistant_involvement_1' }, { id: 'assistant_involvement_2' }])
    const { resolved } = await finalizeStaleAssistantInvolvements(10, exec)
    expect(resolved).toBe(2)
    // The "customer returned" guard rides a correlated NOT EXISTS subquery.
    expect(notExistsSpy).toHaveBeenCalledTimes(1)
  })

  it('is 0 when nothing is stale (the UPDATE matches no rows)', async () => {
    const exec = makeExec([])
    const { resolved } = await finalizeStaleAssistantInvolvements(10, exec)
    expect(resolved).toBe(0)
  })
})
