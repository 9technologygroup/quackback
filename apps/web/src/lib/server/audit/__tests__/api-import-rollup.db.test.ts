/**
 * Real-Postgres proof that an import is summarised, not recorded write by
 * write: every import-mode write a key makes in one minute lands on a single
 * `api.import` row whose count and failures add up, across concurrent writes.
 * The middleware suite mocks the upsert, so only this file shows the counting
 * works in the database.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

if (!process.env.BASE_URL?.startsWith('http')) process.env.BASE_URL = 'http://localhost:3000'
process.env.SECRET_KEY ??= 'test-secret-key-with-at-least-32-characters'

import { db, sql } from '@/lib/server/db'
import { createId, type PrincipalId } from '@quackback/ids'
import { apiKeyAttribution, runWithAuditAttribution, setAuditAttribution } from '../attribution'
import { recordApiWrite } from '../api-write'

let available = false
try {
  await db.execute(sql`select 1`)
  available = true
} catch {
  // Local/unit-only runs without Postgres skip this integration proof.
}

const keyId = createId('api_key')
const otherKeyId = createId('api_key')
const creator = createId('principal') as PrincipalId

function importWrite(key: typeof keyId, status: number) {
  return runWithAuditAttribution(null, async () => {
    setAuditAttribution(
      apiKeyAttribution({ id: key, name: 'Importer', createdById: creator }, 'api'),
      { type: 'service', role: 'admin', authMethod: 'api_key' },
      { importMode: true }
    )
    await recordApiWrite(
      new Request('https://acme.example/api/v1/posts', { method: 'POST' }),
      new Response(null, { status })
    )
  })
}

async function rowsFor(key: string) {
  return (await db.execute(
    sql`SELECT event_type, event_outcome, metadata FROM audit_log
        WHERE credential_id = ${key} ORDER BY occurred_at`
  )) as unknown as Array<{
    event_type: string
    event_outcome: string
    metadata: { window: string; count: number; failures: number }
  }>
}

describe.skipIf(!available)('import-mode audit summary against Postgres', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  afterAll(async () => {
    await db.execute(sql`DELETE FROM audit_log WHERE credential_id IN (${keyId}, ${otherKeyId})`)
  })

  it('counts a minute of writes into one row per key, failures included', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-12T10:15:20.000Z'))

    await Promise.all([
      importWrite(keyId, 201),
      importWrite(keyId, 201),
      importWrite(keyId, 400),
      importWrite(keyId, 201),
      importWrite(otherKeyId, 201),
    ])

    expect(await rowsFor(keyId)).toEqual([
      {
        event_type: 'api.import',
        event_outcome: 'failure',
        metadata: { window: '2026-10-12T10:15:00.000Z', count: 4, failures: 1 },
      },
    ])
    expect(await rowsFor(otherKeyId)).toEqual([
      {
        event_type: 'api.import',
        event_outcome: 'success',
        metadata: { window: '2026-10-12T10:15:00.000Z', count: 1, failures: 0 },
      },
    ])

    // The next minute starts a new row.
    vi.setSystemTime(new Date('2026-10-12T10:16:01.000Z'))
    await importWrite(keyId, 201)
    expect((await rowsFor(keyId)).map((row) => row.metadata)).toEqual([
      { window: '2026-10-12T10:15:00.000Z', count: 4, failures: 1 },
      { window: '2026-10-12T10:16:00.000Z', count: 1, failures: 0 },
    ])
  })
})
