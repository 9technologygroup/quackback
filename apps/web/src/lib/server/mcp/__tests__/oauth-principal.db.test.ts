/**
 * Real-Postgres proof that the OAuth principal re-read names the client in the
 * same statement: the handler suite mocks the database, so only this file can
 * show the subquery is valid SQL and picks the right row.
 */
import { afterAll, describe, expect, it } from 'vitest'

if (!process.env.BASE_URL?.startsWith('http')) process.env.BASE_URL = 'http://localhost:3000'
process.env.SECRET_KEY ??= 'test-secret-key-with-at-least-32-characters'

import { db, sql } from '@/lib/server/db'
import { createId, toUuid, type PrincipalId } from '@quackback/ids'
import { readOAuthPrincipal } from '../oauth-principal'

let available = false
try {
  await db.execute(sql`select 1`)
  available = true
} catch {
  // Local/unit-only runs without Postgres skip this integration proof.
}

const principalId = createId('principal') as PrincipalId
const clientId = `audit-test-${crypto.randomUUID()}`
const otherClientId = `audit-test-${crypto.randomUUID()}`

describe.skipIf(!available)('readOAuthPrincipal against Postgres', () => {
  afterAll(async () => {
    await db.execute(
      sql`DELETE FROM oauth_client WHERE client_id IN (${clientId}, ${otherClientId})`
    )
    await db.execute(sql`DELETE FROM principal WHERE id = ${toUuid(principalId)}::uuid`)
  })

  it('returns the role and the named client from one read', async () => {
    await db.execute(
      sql`INSERT INTO principal (id, role, type, display_name, created_at)
          VALUES (${toUuid(principalId)}::uuid, 'member', 'user', 'Jane', now())`
    )
    await db.execute(
      sql`INSERT INTO oauth_client (id, client_id, name, redirect_uris)
          VALUES (${crypto.randomUUID()}, ${clientId}, 'Claude Desktop', ARRAY['https://a.example/cb']),
                 (${crypto.randomUUID()}, ${otherClientId}, 'Other client', ARRAY['https://b.example/cb'])`
    )

    expect(await readOAuthPrincipal(principalId, clientId)).toEqual({
      role: 'member',
      clientName: 'Claude Desktop',
    })
  })

  it('reads a null name for an unknown or absent client, and null for a missing principal', async () => {
    expect(await readOAuthPrincipal(principalId, 'no-such-client')).toEqual({
      role: 'member',
      clientName: null,
    })
    expect(await readOAuthPrincipal(principalId, null)).toEqual({
      role: 'member',
      clientName: null,
    })
    expect(await readOAuthPrincipal(createId('principal') as PrincipalId, clientId)).toBeNull()
  })
})
