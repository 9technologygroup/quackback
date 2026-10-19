import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { createDb } from '../client'

const migration = readFileSync(
  new URL('../../drizzle/0301_audit_attribution.sql', import.meta.url),
  'utf8'
)
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean)

const ATTRIBUTION_COLUMNS = [
  'channel',
  'client_name',
  'credential_id',
  'credential_kind',
  'on_behalf_of_principal_id',
]

it('adds nullable attribution columns, replays as a no-op and leaves existing rows alone', async () => {
  const db = createDb(
    process.env.DATABASE_URL ?? 'postgresql://postgres:password@localhost:5432/quackback_test',
    { max: 1 }
  )
  const rollback = new Error('owned migration fixture rollback')
  try {
    await db.transaction(async (tx) => {
      const [existing] = await tx.execute(
        sql`INSERT INTO audit_log (id, event_type) VALUES (gen_random_uuid(), 'sso.config.changed') RETURNING id`
      )

      for (const statement of migration) await tx.execute(sql.raw(statement))
      const columnsAfterFirst = await tx.execute(
        sql`SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = 'audit_log' AND column_name IN ${sql.raw(
              `(${ATTRIBUTION_COLUMNS.map((c) => `'${c}'`).join(',')})`
            )}
            ORDER BY column_name`
      )
      // A second run is the fleet gap-heal replay: it must change nothing.
      for (const statement of migration) await tx.execute(sql.raw(statement))
      const columnsAfterReplay = await tx.execute(
        sql`SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = 'audit_log' AND column_name IN ${sql.raw(
              `(${ATTRIBUTION_COLUMNS.map((c) => `'${c}'`).join(',')})`
            )}
            ORDER BY column_name`
      )

      expect(columnsAfterReplay).toEqual(columnsAfterFirst)
      expect(
        columnsAfterFirst.map((c) => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable,
          default: c.column_default,
        }))
      ).toEqual([
        { name: 'channel', type: 'text', nullable: 'YES', default: null },
        { name: 'client_name', type: 'text', nullable: 'YES', default: null },
        { name: 'credential_id', type: 'text', nullable: 'YES', default: null },
        { name: 'credential_kind', type: 'text', nullable: 'YES', default: null },
        { name: 'on_behalf_of_principal_id', type: 'uuid', nullable: 'YES', default: null },
      ])

      // Rows written before the migration carry no attribution: nothing is
      // backfilled, because nothing about them is known.
      const [row] = await tx.execute(
        sql`SELECT channel, credential_kind, credential_id, client_name, on_behalf_of_principal_id
            FROM audit_log WHERE id = ${existing.id}`
      )
      expect(row).toEqual({
        channel: null,
        credential_kind: null,
        credential_id: null,
        client_name: null,
        on_behalf_of_principal_id: null,
      })
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  } finally {
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end()
  }
})
