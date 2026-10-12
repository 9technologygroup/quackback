import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { createDb, type Database } from '../client'

// 0303 gives every role that holds assistant.manage both new AI permissions,
// leaves the old grant in place, and replays as a no-op. Runs in a rolled-back
// transaction against the migrated database.
const MIGRATION = readFileSync(
  join(__dirname, '../../drizzle/0303_ai_permission_split.sql'),
  'utf8'
).replaceAll('--> statement-breakpoint', '')

const DB_URL = process.env.DATABASE_URL
const db: Database | null = DB_URL ? createDb(DB_URL, { max: 1 }) : null

afterAll(async () => {
  // @ts-expect-error optional teardown
  await db?.$client?.end?.()
})

describe.skipIf(!db)('migration 0303 AI permission split', () => {
  it('copies the old grant to both new permissions and replays as a no-op', async () => {
    await db!
      .transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM "role_permissions"`)
        await tx.execute(
          sql`DELETE FROM "permissions" WHERE "key" LIKE 'ai.%' OR "key" IN ('assistant.manage', 'x.other')`
        )
        await tx.execute(
          sql`INSERT INTO "permissions" ("id","key","category","description") VALUES (gen_random_uuid(),'assistant.manage','ai','old'), (gen_random_uuid(),'x.other','ai','x')`
        )
        for (const key of ['holder', 'other'])
          await tx.execute(
            sql`INSERT INTO "roles" ("id","key","name") VALUES (gen_random_uuid(), ${'m0303_' + key}, ${key})`
          )
        await tx.execute(sql`
          INSERT INTO "role_permissions" ("id","role_id","permission_id")
          SELECT gen_random_uuid(), r."id", p."id" FROM "roles" r, "permissions" p
          WHERE (r."key" = 'm0303_holder' AND p."key" = 'assistant.manage')
             OR (r."key" = 'm0303_other' AND p."key" = 'x.other')`)

        const read = async () =>
          (
            (await tx.execute(sql`
              SELECT r."key" AS role, p."key" AS perm FROM "role_permissions" rp
              JOIN "roles" r ON r."id" = rp."role_id"
              JOIN "permissions" p ON p."id" = rp."permission_id"
              ORDER BY 1, 2`)) as unknown as { role: string; perm: string }[]
          ).map((row) => `${row.role}:${row.perm}`)

        await tx.execute(sql.raw(MIGRATION))
        const first = await read()
        expect(first).toEqual([
          'm0303_holder:ai.customer.manage',
          'm0303_holder:ai.teammate.manage',
          'm0303_holder:assistant.manage',
          'm0303_other:x.other',
        ])

        await tx.execute(sql.raw(MIGRATION))
        expect(await read()).toEqual(first)

        throw new Error('__ROLLBACK__')
      })
      .catch((error) => {
        if (!(error instanceof Error) || error.message !== '__ROLLBACK__') throw error
      })
  })
})
