/**
 * Real-Postgres proof that two lifecycle writes linking the same service at
 * once both commit.
 *
 * Each write inserts its status_incident_components row before it recomputes
 * the service. The link's foreign key check takes FOR KEY SHARE on the
 * service row, so by the time either recompute locks that row, both
 * transactions already share it. The recompute's lock must not conflict with
 * KEY SHARE, or each waits on the other and Postgres aborts one as a
 * deadlock.
 *
 * The writes run on their own connections, so their rows have to be
 * committed. They go into copies of the status tables in a schema of this
 * suite's own (with the foreign keys the copy doesn't carry over added back),
 * which no other suite reads and which is dropped at the end.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createId, type StatusComponentId, type StatusIncidentId } from '@quackback/ids'

vi.mock('@/lib/server/events/process', () => ({ processEvent: vi.fn() }))

// Writes that use the global `db` (reordering services) run in this suite's
// schema too.
const globalDb = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: new Proxy(
    {},
    {
      get(_, prop) {
        const target = globalDb.db as Record<string | symbol, unknown>
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      },
    }
  ),
}))

import {
  eq,
  sql,
  statusComponents,
  statusIncidentComponents,
  statusIncidents,
  type Transaction,
} from '@/lib/server/db'
import { reconcileComponentStatus, reorderStatusComponents } from '../status.components'

const schema = `status_locks_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
const TABLES = [
  'status_components',
  'status_incidents',
  'status_incident_components',
  'status_component_events',
]

let admin: postgres.Sql | null = null
let pool: postgres.Sql | null = null
let reorderPool: postgres.Sql | null = null
let available = false
try {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('no test database')
  admin = postgres(url, { max: 1, onnotice: () => {} })
  await admin.unsafe(`create schema ${schema}`)
  for (const table of TABLES) {
    await admin.unsafe(`create table ${schema}."${table}" (like public."${table}" including all)`)
  }
  await admin.unsafe(`
    alter table ${schema}.status_incident_components
      add foreign key (component_id) references ${schema}.status_components (id),
      add foreign key (incident_id) references ${schema}.status_incidents (id);
    alter table ${schema}.status_component_events
      add foreign key (component_id) references ${schema}.status_components (id);
  `)
  pool = postgres(url, {
    max: 4,
    onnotice: () => {},
    // A wait that outlives this is a hang, not a deadlock the server resolves.
    connection: { search_path: schema, application_name: schema, lock_timeout: 15_000 },
  })
  // The global `db`. Its scans read rows in the order they were written (no
  // index order), the plan a small table usually gets anyway.
  reorderPool = postgres(url, {
    max: 2,
    onnotice: () => {},
    connection: {
      search_path: schema,
      application_name: `${schema}_g`,
      lock_timeout: 15_000,
      enable_indexscan: 'off',
      enable_bitmapscan: 'off',
      enable_indexonlyscan: 'off',
    },
  })
  globalDb.db = drizzle(reorderPool)
  available = true
} catch {
  // Local/unit-only runs without Postgres skip this integration proof.
}

const db = pool ? drizzle(pool) : null

afterAll(async () => {
  await reorderPool?.end()
  await pool?.end()
  await admin?.unsafe(`drop schema if exists ${schema} cascade`).catch(() => {})
  await admin?.end()
})

/** A deferred: a promise plus the function that settles it. */
function signal<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Resolves once backend `pid` is waiting on a lock, or once `stop` settles. */
async function blockedOnLock(pid: number, stop: Promise<unknown>): Promise<void> {
  let stopped = false
  void stop.finally(() => {
    stopped = true
  })
  while (!stopped) {
    const [row] = await admin!<{ waiting: boolean }[]>`
      select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = ${pid}`
    if (row?.waiting) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Resolves once a connection of the global `db` waits on a lock, or once
 *  `stop` settles. */
async function globalDbBlocked(stop: Promise<unknown>): Promise<void> {
  let stopped = false
  void stop.finally(() => {
    stopped = true
  })
  while (!stopped) {
    const [row] = await admin!<{ waiting: number }[]>`
      select count(*)::int as waiting from pg_stat_activity
       where application_name = ${`${schema}_g`} and wait_event_type = 'Lock'`
    if (row!.waiting > 0) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function backendPid(tx: Transaction): Promise<number> {
  const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
  return row.pid
}

describe.skipIf(!available)('two writes linking one service at once', () => {
  beforeEach(async () => {
    for (const table of [...TABLES].reverse()) {
      await admin!.unsafe(`delete from ${schema}."${table}"`)
    }
  })

  it('both commit, and the service ends at the worse of the two', async () => {
    const service = createId('status_component') as StatusComponentId
    const first = createId('status_incident') as StatusIncidentId
    const second = createId('status_incident') as StatusIncidentId
    await db!.insert(statusComponents).values({ id: service, name: 'API' })
    await db!.insert(statusIncidents).values([
      { id: first, kind: 'incident', title: 'Errors', status: 'investigating' },
      { id: second, kind: 'incident', title: 'Latency', status: 'investigating' },
    ])

    const firstLinked = signal<number>()
    const secondLinked = signal<number>()
    const firstRecomputed = signal()
    const secondSettled = signal()

    // The first write links the service and recomputes it, but holds its
    // transaction open until the second write is queued behind it.
    const firstWrite = db!.transaction(async (raw) => {
      const tx = raw as unknown as Transaction
      await tx.insert(statusIncidentComponents).values({
        incidentId: first,
        componentId: service,
        componentStatus: 'major_outage',
      })
      firstLinked.resolve(await backendPid(tx))
      await secondLinked.promise
      await reconcileComponentStatus(service, 'incident', first, tx)
      firstRecomputed.resolve()
      await blockedOnLock(await secondLinked.promise, secondSettled.promise)
    })

    // The second write links the same service once the first has, then
    // recomputes while the first is still open (blocked, or holding the row).
    const secondWrite = db!.transaction(async (raw) => {
      const tx = raw as unknown as Transaction
      const firstPid = await firstLinked.promise
      await tx.insert(statusIncidentComponents).values({
        incidentId: second,
        componentId: service,
        componentStatus: 'partial_outage',
      })
      secondLinked.resolve(await backendPid(tx))
      await blockedOnLock(firstPid, firstRecomputed.promise)
      await reconcileComponentStatus(service, 'incident', second, tx)
    })
    void secondWrite.then(secondSettled.resolve, secondSettled.resolve)

    const results = await Promise.allSettled([firstWrite, secondWrite])
    // A deadlock surfaces as SQLSTATE 40P01 on whichever write Postgres aborts.
    type QueryError = { code?: string; cause?: { code?: string; message?: string } }
    const failures = results.flatMap((r) => {
      if (r.status === 'fulfilled') return []
      const err = r.reason as QueryError
      return [`${err.cause?.code ?? err.code}: ${err.cause?.message ?? String(r.reason)}`]
    })
    expect(failures).toEqual([])

    const [row] = await db!
      .select({ status: statusComponents.status })
      .from(statusComponents)
      .where(eq(statusComponents.id, service))
    expect(row.status).toBe('major_outage')
    expect(await db!.select().from(statusIncidentComponents)).toHaveLength(2)
  })
})

describe.skipIf(!available)('reordering services while a lifecycle write recomputes them', () => {
  beforeEach(async () => {
    for (const table of [...TABLES].reverse()) {
      await admin!.unsafe(`delete from ${schema}."${table}"`)
    }
  })

  it('both commit, whichever order the services are listed and stored in', async () => {
    const [low, high] = [
      createId('status_component') as StatusComponentId,
      createId('status_component') as StatusComponentId,
    ].sort()
    // Stored highest id first, and moved to the top by the reorder.
    await db!.insert(statusComponents).values({ id: high, name: 'Website', position: 1 })
    await db!.insert(statusComponents).values({ id: low, name: 'API', position: 0 })

    const lowLocked = signal()
    const reorderSettled = signal()

    // A recompute takes its services in id order: the lower one, then (once
    // the reorder is waiting) the higher one.
    const recompute = db!.transaction(async (raw) => {
      const tx = raw as unknown as Transaction
      await reconcileComponentStatus(low, 'incident', null, tx)
      lowLocked.resolve()
      await globalDbBlocked(reorderSettled.promise)
      await reconcileComponentStatus(high, 'incident', null, tx)
    })

    await lowLocked.promise
    const reorder = reorderStatusComponents([high, low])
    void reorder.then(reorderSettled.resolve, reorderSettled.resolve)

    // A deadlock surfaces as SQLSTATE 40P01 on whichever write Postgres aborts.
    type QueryError = { code?: string; cause?: { code?: string; message?: string } }
    const results = await Promise.allSettled([recompute, reorder])
    const failures = results.flatMap((r) => {
      if (r.status === 'fulfilled') return []
      const err = r.reason as QueryError
      return [`${err.cause?.code ?? err.code}: ${err.cause?.message ?? String(r.reason)}`]
    })
    expect(failures).toEqual([])

    const rows = await db!
      .select({ id: statusComponents.id, position: statusComponents.position })
      .from(statusComponents)
    expect(Object.fromEntries(rows.map((r) => [r.id, r.position]))).toEqual({ [high]: 0, [low]: 1 })
  })
})
