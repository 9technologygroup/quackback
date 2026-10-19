import { describe, it, expect, afterAll } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { createDb, type Database } from '../client'
import { roles, permissions, rolePermissions } from '../schema/rbac'
import { seedSystemData } from '../seed-system'
import {
  ALL_PERMISSIONS,
  SYSTEM_ROLES,
  SYSTEM_ROLE_PERMISSIONS,
  PERMISSION_CATALOGUE,
  RETIRED_PERMISSION_KEYS,
  type SystemRoleKey,
} from '../rbac-catalogue'

// Exercises seedSystemData against a migrated DB inside a rolled-back
// transaction (the 0126 tables must exist). Idempotent reconcile, so it never
// mutates the dev DB. Skips when DATABASE_URL is absent (CI without Postgres).
const DB_URL = process.env.DATABASE_URL
let db: Database | null = null
if (DB_URL) db = createDb(DB_URL, { max: 1 })

afterAll(async () => {
  // @ts-expect-error optional teardown
  await db?.$client?.end?.()
})

const ROLLBACK = '__ROLLBACK__'

describe.skipIf(!DB_URL)('seedSystemData', () => {
  it('reconciles the catalogue + presets and is idempotent', async () => {
    if (!db) return
    await db
      .transaction(async (tx) => {
        await seedSystemData(tx)

        // Every catalogue permission is present.
        const permRows = await tx.select({ key: permissions.key }).from(permissions)
        const permKeys = new Set(permRows.map((p) => p.key))
        for (const k of ALL_PERMISSIONS) expect(permKeys.has(k)).toBe(true)

        // Exactly the system-role presets.
        const sysRoleRows = await tx
          .select({ key: roles.key })
          .from(roles)
          .where(eq(roles.isSystem, true))
        expect(new Set(sysRoleRows.map((r) => r.key))).toEqual(new Set(Object.values(SYSTEM_ROLES)))

        // Each preset's resolved bundle equals SYSTEM_ROLE_PERMISSIONS.
        const bundleByRole = await resolveBundles(tx)
        for (const roleKey of Object.values(SYSTEM_ROLES) as SystemRoleKey[]) {
          expect(bundleByRole.get(roleKey)).toEqual(new Set(SYSTEM_ROLE_PERMISSIONS[roleKey]))
        }

        // Idempotent: a second run leaves role_permissions row count unchanged.
        const before = (await tx.select({ id: rolePermissions.id }).from(rolePermissions)).length
        await seedSystemData(tx)
        const after = (await tx.select({ id: rolePermissions.id }).from(rolePermissions)).length
        expect(after).toBe(before)

        throw new Error(ROLLBACK)
      })
      .catch((e) => {
        if (!(e instanceof Error) || e.message !== ROLLBACK) throw e
      })
  })

  it('leaves a retired key and its preset grants alone', async () => {
    if (!db) return
    await db
      .transaction(async (tx) => {
        await seedSystemData(tx)
        await tx.execute(
          sql`INSERT INTO "permissions" ("id","key","category","description") VALUES (gen_random_uuid(),'assistant.manage','ai','old') ON CONFLICT ("key") DO NOTHING`
        )
        await tx.execute(sql`
          INSERT INTO "role_permissions" ("id","role_id","permission_id")
          SELECT gen_random_uuid(), r."id", p."id" FROM "roles" r, "permissions" p
          WHERE r."key" = 'admin' AND p."key" = 'assistant.manage'
          ON CONFLICT DO NOTHING`)
        await seedSystemData(tx)
        const kept = (await tx.execute(sql`
          SELECT 1 FROM "role_permissions" rp
          JOIN "roles" r ON r."id" = rp."role_id" JOIN "permissions" p ON p."id" = rp."permission_id"
          WHERE r."key" = 'admin' AND p."key" = 'assistant.manage'`)) as unknown as unknown[]
        expect(kept.length).toBe(1)
        throw new Error(ROLLBACK)
      })
      .catch((e) => {
        if (!(e instanceof Error) || e.message !== ROLLBACK) throw e
      })
  })

  it('reconciles description drift on re-run', async () => {
    if (!db) return
    const sample = PERMISSION_CATALOGUE[0]
    await db
      .transaction(async (tx) => {
        await seedSystemData(tx)
        await tx
          .update(permissions)
          .set({ description: 'STALE', category: 'workspace' })
          .where(eq(permissions.key, sample.key))
        await seedSystemData(tx)
        const [row] = await tx
          .select({ description: permissions.description, category: permissions.category })
          .from(permissions)
          .where(eq(permissions.key, sample.key))
        expect(row.description).toBe(sample.description)
        expect(row.category).toBe(sample.category)
        throw new Error(ROLLBACK)
      })
      .catch((e) => {
        if (!(e instanceof Error) || e.message !== ROLLBACK) throw e
      })
  })
})

async function resolveBundles(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0]
): Promise<Map<string, Set<string>>> {
  const rows = await tx
    .select({ roleKey: roles.key, permKey: permissions.key })
    .from(rolePermissions)
    .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
  const byRole = new Map<string, Set<string>>()
  for (const r of rows) {
    // Retired keys keep their grants for older app versions; they are not part of a bundle.
    if (RETIRED_PERMISSION_KEYS.includes(r.permKey)) continue
    if (!byRole.has(r.roleKey)) byRole.set(r.roleKey, new Set())
    byRole.get(r.roleKey)!.add(r.permKey)
  }
  return byRole
}
