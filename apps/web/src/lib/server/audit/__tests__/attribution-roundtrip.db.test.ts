/**
 * Real-Postgres round trip: an audit event recorded under a boundary lands
 * with its attribution columns, and the admin feed reads them back with the
 * name of the person the credential acted for. The unit suites mock the
 * database on both sides, so only this file shows the columns and the name
 * lookup work against the real schema.
 */
import { afterAll, describe, expect, it } from 'vitest'

if (!process.env.BASE_URL?.startsWith('http')) process.env.BASE_URL = 'http://localhost:3000'
process.env.SECRET_KEY ??= 'test-secret-key-with-at-least-32-characters'

import { db, sql } from '@/lib/server/db'
import { createId, toUuid, type PrincipalId, type UserId } from '@quackback/ids'
import { apiKeyAttribution, runWithAuditAttribution } from '../attribution'
import { queryAuditEvents, recordAuditEvent } from '../log'

let available = false
try {
  await db.execute(sql`select 1`)
  available = true
} catch {
  // Local/unit-only runs without Postgres skip this integration proof.
}

const userId = createId('user') as UserId
const creator = createId('principal') as PrincipalId
const removed = createId('principal') as PrincipalId
const keyId = createId('api_key')
const marker = `audit-roundtrip-${crypto.randomUUID()}@example.com`

describe.skipIf(!available)('audit attribution against Postgres', () => {
  afterAll(async () => {
    await db.execute(sql`DELETE FROM audit_log WHERE actor_email = ${marker}`)
    await db.execute(sql`DELETE FROM principal WHERE id = ${toUuid(creator)}::uuid`)
    await db.execute(sql`DELETE FROM "user" WHERE id = ${toUuid(userId)}::uuid`)
  })

  it('stores the attribution and reads it back with the creator’s name', async () => {
    await db.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
          VALUES (${toUuid(userId)}::uuid, 'James Morton', ${`owner-${marker}`}, true, now(), now())`
    )
    await db.execute(
      sql`INSERT INTO principal (id, user_id, role, type, created_at)
          VALUES (${toUuid(creator)}::uuid, ${toUuid(userId)}::uuid, 'admin', 'user', now())`
    )

    await runWithAuditAttribution(
      apiKeyAttribution({ id: keyId, name: 'Zapier', createdById: creator }, 'api'),
      () => recordAuditEvent({ event: 'api.write', actor: { email: marker, type: 'service' } })
    )
    // A key whose creator has since been removed keeps the id, with no name.
    await runWithAuditAttribution(
      apiKeyAttribution({ id: keyId, name: 'Zapier', createdById: removed }, 'api'),
      () => recordAuditEvent({ event: 'api.write', actor: { email: marker, type: 'service' } })
    )

    const rows = await queryAuditEvents({ actorEmail: marker, limit: 10 })
    expect(
      rows
        .map((row) => ({
          channel: row.channel,
          credentialKind: row.credentialKind,
          credentialId: row.credentialId,
          clientName: row.clientName,
          onBehalfOfPrincipalId: row.onBehalfOfPrincipalId,
          onBehalfOfName: row.onBehalfOfName,
        }))
        .sort((a, b) => String(a.onBehalfOfName).localeCompare(String(b.onBehalfOfName)))
    ).toEqual([
      {
        channel: 'api',
        credentialKind: 'api_key',
        credentialId: keyId,
        clientName: 'Zapier',
        onBehalfOfPrincipalId: creator,
        onBehalfOfName: 'James Morton',
      },
      {
        channel: 'api',
        credentialKind: 'api_key',
        credentialId: keyId,
        clientName: 'Zapier',
        onBehalfOfPrincipalId: removed,
        onBehalfOfName: null,
      },
    ])
  })
})
