/**
 * Real-Postgres proof that approval bells batch atomically: requests that
 * reach one person at the same moment count up one unread row, never two rows
 * and never a lost count.
 *
 * The racing connections have to see each other's rows, so they commit, into
 * a copy of the notifications table (with its indexes) in a schema of this
 * suite's own: no other suite's transaction can read what it commits.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import postgres from 'postgres'
import { createId, type PrincipalId } from '@quackback/ids'

const race = vi.hoisted(() => ({
  schema: `bell_race_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  db: null as unknown,
}))

// Domain code imports the global `db`; point it at this suite's schema.
vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: new Proxy(
    {},
    {
      get(_, prop) {
        const target = race.db as Record<string | symbol, unknown>
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      },
    }
  ),
}))

// Same sanctioned direct client import as the db test fixture: this suite
// builds its own connections rather than going through the global `db`.
// oxlint-disable-next-line no-restricted-imports
import { createDbFromSql } from '@quackback/db/client'
import { db, and, eq, isNull, inAppNotifications } from '@/lib/server/db'
import {
  approvalBellTitle,
  markApprovalBellsRead,
  ringApprovalBells,
} from '../notification.service'

let admin: postgres.Sql | null = null
let pool: postgres.Sql | null = null
let available = false
try {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('no test database')
  admin = postgres(url, { max: 1, onnotice: () => {} })
  await admin.unsafe(`create schema ${race.schema}`)
  await admin.unsafe(
    `create table ${race.schema}.in_app_notifications (like public.in_app_notifications including all)`
  )
  pool = postgres(url, { max: 10, connection: { search_path: `${race.schema}, public` } })
  race.db = createDbFromSql(pool)
  available = true
} catch {
  // Local/unit-only runs without Postgres skip this integration proof.
}

afterAll(async () => {
  await pool?.end()
  await admin?.unsafe(`drop schema if exists ${race.schema} cascade`).catch(() => {})
  await admin?.end()
})

const bell = (principalId: PrincipalId, approvalId: string) => ({
  principalId,
  type: 'approval_requested' as const,
  title: approvalBellTitle(1),
  body: `Summary of ${approvalId}`,
  metadata: { approvalId, count: 1 },
})

const unreadBells = (principalId: PrincipalId) =>
  db
    .select()
    .from(inAppNotifications)
    .where(
      and(
        eq(inAppNotifications.principalId, principalId),
        eq(inAppNotifications.type, 'approval_requested'),
        isNull(inAppNotifications.readAt)
      )
    )

describe.skipIf(!available)('approval bells under concurrent requests', () => {
  it('counts every request in one unread bell when they arrive at once', async () => {
    const principalId = createId('principal') as PrincipalId
    const calls = 10
    await Promise.all(
      Array.from({ length: calls }, (_, n) => ringApprovalBells([bell(principalId, `a${n}`)]))
    )
    const rows = await unreadBells(principalId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.metadata).toMatchObject({ count: calls })
    expect(rows[0]!.title).toBe(`${calls} new approval requests`)
    // Several requests have no one summary to show.
    expect(rows[0]!.body).toBeNull()
  })

  it('words one new request and many', () => {
    expect(approvalBellTitle(1)).toBe('New approval request')
    expect(approvalBellTitle(2)).toBe('2 new approval requests')
    expect(approvalBellTitle(12)).toBe('12 new approval requests')
  })

  it('counts only requests since the person last read it', async () => {
    const principalId = createId('principal') as PrincipalId
    const other = createId('principal') as PrincipalId
    await ringApprovalBells([bell(principalId, 'first'), bell(other, 'first')])
    await ringApprovalBells([bell(principalId, 'second')])
    expect((await unreadBells(principalId))[0]!.title).toBe('2 new approval requests')

    // Opening the queue reads the bell: only this person's, only this type.
    expect(await markApprovalBellsRead(principalId)).toBe(1)
    expect(await unreadBells(principalId)).toHaveLength(0)
    expect(await unreadBells(other)).toHaveLength(1)
    expect(await markApprovalBellsRead(principalId)).toBe(0)

    await ringApprovalBells([bell(principalId, 'third')])
    const rows = await unreadBells(principalId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.metadata).toMatchObject({ approvalId: 'third', count: 1 })
    expect(rows[0]!.title).toBe('New approval request')
    expect(rows[0]!.body).toBe('Summary of third')
  })
})
