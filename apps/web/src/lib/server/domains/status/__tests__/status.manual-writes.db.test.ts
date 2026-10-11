/**
 * Real-Postgres proof that a manual lifecycle write (an editor save, a posted
 * update) and the scheduler starting or completing the same window each act
 * on the window as the other left it, whichever goes first.
 *
 * The first one's transaction is held open after it has locked the window:
 * this suite holds a lock on the window's service, which the scheduler waits
 * for when it recomputes it, and an editor save waits for when it relinks
 * it. The second is sent while the first waits, and the lock is released
 * once both are queued, so the first always commits first.
 *
 * The writes run on their own connections, so their rows have to be
 * committed. They go into copies of the status tables in a schema of this
 * suite's own (with the foreign keys the copy doesn't carry over added back),
 * which no other suite reads and which is dropped at the end.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { StatusComponentId, StatusIncidentId } from '@quackback/ids'

const race = vi.hoisted(() => ({
  schema: `status_manual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
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

const mockProcessEvent = vi.hoisted(() => vi.fn())
vi.mock('@/lib/server/events/process', () => ({
  processEvent: (...args: unknown[]) => mockProcessEvent(...args),
}))
vi.mock('@/lib/server/events/scheduler', () => ({
  scheduleDispatch: vi.fn().mockResolvedValue(undefined),
  cancelScheduledDispatch: vi.fn().mockResolvedValue(undefined),
}))

import {
  eq,
  statusComponentEvents,
  statusComponents,
  statusIncidentComponents,
  statusIncidents,
  statusIncidentUpdates,
} from '@/lib/server/db'
import { createStatusComponent } from '../status.components'
import {
  createIncident,
  getStatusIncidentById,
  postIncidentUpdate,
  updateIncident,
} from '../status.service'
import { handleMaintenanceComplete, handleMaintenanceStart } from '../status.maintenance'

const TABLES = [
  'status_components',
  'status_incidents',
  'status_incident_updates',
  'status_incident_components',
  'status_component_events',
]

let admin: postgres.Sql | null = null
let pool: postgres.Sql | null = null
let locker: postgres.Sql | null = null
let lockerDb: ReturnType<typeof drizzle> | null = null
let available = false
try {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('no test database')
  admin = postgres(url, { max: 1, onnotice: () => {} })
  await admin.unsafe(`create schema ${race.schema}`)
  for (const table of TABLES) {
    await admin.unsafe(
      `create table ${race.schema}."${table}" (like public."${table}" including all)`
    )
  }
  await admin.unsafe(`
    alter table ${race.schema}.status_incident_updates
      add foreign key (incident_id) references ${race.schema}.status_incidents (id);
    alter table ${race.schema}.status_incident_components
      add foreign key (component_id) references ${race.schema}.status_components (id),
      add foreign key (incident_id) references ${race.schema}.status_incidents (id);
    alter table ${race.schema}.status_component_events
      add foreign key (component_id) references ${race.schema}.status_components (id);
  `)
  pool = postgres(url, {
    max: 4,
    onnotice: () => {},
    // A wait that outlives this is a hang, not a lock the test releases.
    connection: { search_path: race.schema, application_name: race.schema, lock_timeout: 15_000 },
  })
  race.db = drizzle(pool, {
    schema: {
      statusComponents,
      statusComponentEvents,
      statusIncidents,
      statusIncidentComponents,
      statusIncidentUpdates,
    },
  })
  // The suite's own lock on a service, held from a connection of its own.
  locker = postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: { search_path: race.schema },
  })
  lockerDb = drizzle(locker)
  available = true
} catch {
  // Local/unit-only runs without Postgres skip this integration proof.
}

afterAll(async () => {
  await locker?.end()
  await pool?.end()
  await admin?.unsafe(`drop schema if exists ${race.schema} cascade`).catch(() => {})
  await admin?.end()
})

const HOUR = 60 * 60 * 1000
const T0 = new Date('2026-10-10T08:00:00.000Z').getTime()

/** Hold `componentId`'s row locked until the returned release is called. */
async function holdService(componentId: StatusComponentId): Promise<() => Promise<void>> {
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let locked!: () => void
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve
  })
  const holding = lockerDb!.transaction(async (tx) => {
    await tx
      .select({ id: statusComponents.id })
      .from(statusComponents)
      .where(eq(statusComponents.id, componentId))
      .for('update')
    locked()
    await released
  })
  await isLocked
  return async () => {
    release()
    await holding
  }
}

/** Resolves once `count` of this suite's connections are waiting on a lock. */
async function waitingOnLocks(count: number): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const [row] = await admin!<{ waiting: number }[]>`
      select count(*)::int as waiting from pg_stat_activity
       where application_name = ${race.schema} and wait_event_type = 'Lock'`
    if (row!.waiting >= count) return
    if (Date.now() > deadline) throw new Error(`only ${row!.waiting} of ${count} writes waiting`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function maintenance(status: 'scheduled' | 'in_progress', start: number, end: number) {
  const service = await createStatusComponent({ name: 'Database' })
  const window = await createIncident(
    {
      kind: 'maintenance',
      title: 'Upgrade',
      status,
      body: 'Planned upgrade.',
      affectedComponents: [{ componentId: service.id, componentStatus: 'under_maintenance' }],
      scheduledStartAt: new Date(start),
      scheduledEndAt: new Date(end),
      notifySubscribers: false,
    },
    { principalId: null as never }
  )
  return { id: window.id as StatusIncidentId, service: service.id }
}

describe.skipIf(!available)('a manual write while the scheduler moves the window', () => {
  beforeEach(async () => {
    mockProcessEvent.mockReset().mockResolvedValue(undefined)
    for (const table of [...TABLES].reverse()) {
      await admin!.unsafe(`delete from ${race.schema}."${table}"`)
    }
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0 - HOUR)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a reschedule saved as the window starts leaves the real start alone', async () => {
    const window = await maintenance('scheduled', T0 - 60_000, T0 + HOUR)
    const release = await holdService(window.service)

    vi.setSystemTime(T0)
    const starting = handleMaintenanceStart(window.id)
    await waitingOnLocks(1)
    vi.setSystemTime(T0 + 60_000)
    const saving = updateIncident(window.id, {
      scheduledStartAt: new Date(T0 + 2 * HOUR),
      scheduledEndAt: new Date(T0 + 3 * HOUR),
    })
    await waitingOnLocks(2)
    await release()
    await Promise.all([starting, saving])

    const after = await getStatusIncidentById(window.id)
    expect(after.status).toBe('in_progress')
    expect(after.startedAt.getTime()).toBe(T0)
    expect(after.scheduledStartAt?.getTime()).toBe(T0 + 2 * HOUR)
  })

  it('an in-progress update posted as the window starts is an update, not a second start', async () => {
    const window = await maintenance('scheduled', T0 - 60_000, T0 + HOUR)
    const release = await holdService(window.service)

    vi.setSystemTime(T0)
    const starting = handleMaintenanceStart(window.id)
    await waitingOnLocks(1)
    vi.setSystemTime(T0 + 60_000)
    const posting = postIncidentUpdate(
      window.id,
      { status: 'in_progress', body: 'Starting the upgrade.' },
      { principalId: null }
    )
    await waitingOnLocks(2)
    await release()
    await Promise.all([starting, posting])

    const after = await getStatusIncidentById(window.id)
    expect(after.status).toBe('in_progress')
    expect(after.startedAt.getTime()).toBe(T0)
    // The scheduler's start and the admin's words, each once.
    expect(after.updates.map((u) => u.body).sort()).toEqual([
      'Planned upgrade.',
      'Starting the upgrade.',
      'This scheduled maintenance is now in progress.',
    ])
  })

  it('a completion posted as the window completes keeps the first completion time', async () => {
    const window = await maintenance('in_progress', T0 - 2 * HOUR, T0 - 60_000)
    const release = await holdService(window.service)

    vi.setSystemTime(T0)
    const completing = handleMaintenanceComplete(window.id)
    await waitingOnLocks(1)
    vi.setSystemTime(T0 + 60_000)
    const posting = postIncidentUpdate(
      window.id,
      { status: 'completed', body: 'All done.' },
      { principalId: null }
    )
    await waitingOnLocks(2)
    await release()
    await Promise.all([completing, posting])

    const after = await getStatusIncidentById(window.id)
    expect(after.status).toBe('completed')
    expect(after.resolvedAt?.getTime()).toBe(T0)
  })
})

describe.skipIf(!available)('the scheduler while a manual write holds the window', () => {
  beforeEach(async () => {
    mockProcessEvent.mockReset().mockResolvedValue(undefined)
    for (const table of [...TABLES].reverse()) {
      await admin!.unsafe(`delete from ${race.schema}."${table}"`)
    }
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0 - HOUR)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a start that is due no more after a reschedule does nothing', async () => {
    const window = await maintenance('scheduled', T0 - 60_000, T0 + HOUR)
    const release = await holdService(window.service)

    vi.setSystemTime(T0)
    // The editor's save relinks the service, so it waits on it holding the
    // window's lock.
    const saving = updateIncident(window.id, {
      scheduledStartAt: new Date(T0 + 2 * HOUR),
      scheduledEndAt: new Date(T0 + 3 * HOUR),
      affectedComponents: [{ componentId: window.service, componentStatus: 'under_maintenance' }],
    })
    await waitingOnLocks(1)
    const starting = handleMaintenanceStart(window.id)
    await waitingOnLocks(2)
    await release()
    await Promise.all([saving, starting])

    const after = await getStatusIncidentById(window.id)
    expect(after.status).toBe('scheduled')
    expect(after.startedAt.getTime()).toBe(T0 + 2 * HOUR)
    expect(after.updates.map((u) => u.status)).toEqual(['scheduled'])
  })

  it('a completion does nothing once auto-complete was switched off', async () => {
    const window = await maintenance('in_progress', T0 - 2 * HOUR, T0 - 60_000)
    const release = await holdService(window.service)

    vi.setSystemTime(T0)
    const saving = updateIncident(window.id, {
      autoComplete: false,
      affectedComponents: [{ componentId: window.service, componentStatus: 'under_maintenance' }],
    })
    await waitingOnLocks(1)
    const completing = handleMaintenanceComplete(window.id)
    await waitingOnLocks(2)
    await release()
    await Promise.all([saving, completing])

    const after = await getStatusIncidentById(window.id)
    expect(after.status).toBe('in_progress')
    expect(after.resolvedAt).toBeNull()
  })
})
