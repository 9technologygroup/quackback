/**
 * startMaintenanceNow: the admin "Start now" for a scheduled window.
 *
 * handleMaintenanceStart's guard waits for the planned start, so an early
 * start can't go through it. The wrapper starts the window itself and keeps
 * the plan: started_at records the real start, the scheduled bounds stay as
 * planned (the public page shows that window), and completion stays armed for
 * the planned end. This suite pins the wrapper's contract: guard, start-job
 * cancellation, no bound rewrite, the start itself, and the completion job.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StatusComponentId, StatusIncidentId } from '@quackback/ids'
import { ValidationError, NotFoundError } from '@/lib/shared/errors'

const mockIncidentFindFirst = vi.fn()
const mockIncidentComponentsFindMany = vi.fn()
const mockIncidentUpdateSet = vi.fn()
const mockUpdatesInsertValues = vi.fn()
const mockReconcileComponentStatus = vi.fn()
const mockDispatchStatusEvent = vi.fn().mockResolvedValue(undefined)
const mockScheduleDispatch = vi.fn()
const mockCancelScheduledDispatch = vi.fn()

vi.mock('@/lib/server/db', async (importOriginal) => {
  // Lifecycle writes run in a transaction; the mock hands the same stubs in
  // as the transaction handle.
  const db = {
    query: {
      statusIncidents: { findFirst: (...args: unknown[]) => mockIncidentFindFirst(...args) },
      statusIncidentComponents: {
        findMany: (...args: unknown[]) => mockIncidentComponentsFindMany(...args),
      },
    },
    update: () => ({
      set: (arg: unknown) => {
        mockIncidentUpdateSet(arg)
        // The start/complete claim reads back the row it matched.
        return {
          where: () =>
            Object.assign(Promise.resolve(), {
              returning: async () => [{ ...(await mockIncidentFindFirst()), ...(arg as object) }],
            }),
        }
      },
    }),
    insert: () => ({
      values: (arg: unknown) => {
        mockUpdatesInsertValues(arg)
        return Promise.resolve()
      },
    }),
    // Settling started_at builds subqueries; the stubbed updates ignore them.
    select: () => ({ from: () => ({ where: () => ({}) }) }),
    transaction: (fn: (tx: unknown) => unknown) => fn(db),
  }
  return { ...(await importOriginal<typeof import('@/lib/server/db')>()), db }
})

vi.mock('../status.components', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../status.components')>()),
  reconcileComponentStatus: (...args: unknown[]) => mockReconcileComponentStatus(...args),
  // The batch form recomputes each component in id order through the single one.
  reconcileComponentStatuses: async (ids: Iterable<string>, ...rest: unknown[]) => {
    for (const id of [...new Set(ids)].sort()) await mockReconcileComponentStatus(id, ...rest)
  },
  dispatchStatusEvent: (...args: unknown[]) => mockDispatchStatusEvent(...args),
}))

vi.mock('@/lib/server/events/scheduler', () => ({
  scheduleDispatch: (...args: unknown[]) => mockScheduleDispatch(...args),
  cancelScheduledDispatch: (...args: unknown[]) => mockCancelScheduledDispatch(...args),
}))

import { startMaintenanceNow } from '../status.maintenance'

const INCIDENT_ID = 'si_startnow1' as StatusIncidentId
const COMPONENT_ID = 'sc_comp1' as StatusComponentId

const FUTURE_START = new Date(Date.now() + 60 * 60 * 1000)
const FUTURE_END = new Date(Date.now() + 3 * 60 * 60 * 1000)

function scheduledWindow(overrides: Record<string, unknown> = {}) {
  return {
    id: INCIDENT_ID,
    kind: 'maintenance',
    status: 'scheduled',
    title: 'Failover test',
    scheduledStartAt: FUTURE_START,
    scheduledEndAt: FUTURE_END,
    autoStart: true,
    autoComplete: true,
    resolvedAt: null,
    deletedAt: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIncidentComponentsFindMany.mockResolvedValue([
    { incidentId: INCIDENT_ID, componentId: COMPONENT_ID, componentStatus: 'under_maintenance' },
  ])
  mockReconcileComponentStatus.mockResolvedValue(undefined)
  mockScheduleDispatch.mockResolvedValue(undefined)
  mockCancelScheduledDispatch.mockResolvedValue(undefined)
})

describe('startMaintenanceNow', () => {
  it('rejects a non-maintenance incident', async () => {
    mockIncidentFindFirst.mockResolvedValue(scheduledWindow({ kind: 'incident' }))
    await expect(startMaintenanceNow(INCIDENT_ID)).rejects.toBeInstanceOf(ValidationError)
    expect(mockIncidentUpdateSet).not.toHaveBeenCalled()
  })

  it('rejects a window that is not scheduled (already started)', async () => {
    mockIncidentFindFirst.mockResolvedValue(scheduledWindow({ status: 'in_progress' }))
    await expect(startMaintenanceNow(INCIDENT_ID)).rejects.toBeInstanceOf(ValidationError)
    expect(mockIncidentUpdateSet).not.toHaveBeenCalled()
  })

  it('404s a missing/deleted window', async () => {
    mockIncidentFindFirst.mockResolvedValue(undefined)
    await expect(startMaintenanceNow(INCIDENT_ID)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('starts the window now, keeps its plan, and keeps completion at the planned end', async () => {
    const window = scheduledWindow()
    mockIncidentFindFirst.mockResolvedValue(window)

    await startMaintenanceNow(INCIDENT_ID)

    // The plan is unchanged, so the schedule hash is too: the pending start
    // job is cancelled and the completion job keeps its id.
    const hash = `${FUTURE_START.getTime()}-${FUTURE_END.getTime()}`
    expect(mockCancelScheduledDispatch).toHaveBeenCalledWith(
      `status-maintenance-start--${INCIDENT_ID}--${hash}`
    )
    expect(mockCancelScheduledDispatch).not.toHaveBeenCalledWith(
      `status-maintenance-complete--${INCIDENT_ID}--${hash}`
    )

    // The start is one write to the row: in_progress with the real start.
    // Settling started_at after it writes nothing else, and the scheduled
    // bounds are never rewritten.
    const writes = mockIncidentUpdateSet.mock.calls.map(([w]) => w as Record<string, unknown>)
    const [write, ...settles] = writes
    expect(write).toMatchObject({ status: 'in_progress' })
    expect((write.startedAt as Date).getTime()).toBeLessThanOrEqual(Date.now())
    expect(settles.map((w) => Object.keys(w))).toEqual(settles.map(() => ['startedAt']))
    for (const w of writes) {
      expect(w).not.toHaveProperty('scheduledStartAt')
      expect(w).not.toHaveProperty('scheduledEndAt')
    }

    // The window actually started: component reconcile + the timeline entry.
    expect(mockReconcileComponentStatus).toHaveBeenCalledWith(
      COMPONENT_ID,
      'maintenance',
      INCIDENT_ID,
      expect.anything()
    )
    expect(mockUpdatesInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'in_progress' })
    )

    // Completion re-armed under the same id, for the planned end.
    const completeCall = mockScheduleDispatch.mock.calls.find(
      (c) =>
        (c[0] as { jobId: string }).jobId === `status-maintenance-complete--${INCIDENT_ID}--${hash}`
    )
    expect(completeCall).toBeDefined()
    const delayMs = (completeCall![0] as { delayMs: number }).delayMs
    expect(delayMs).toBeLessThanOrEqual(FUTURE_END.getTime() - Date.now() + 1000)
    expect(delayMs).toBeGreaterThan(FUTURE_END.getTime() - Date.now() - 60_000)
    // No start job re-enqueued: the window is already in progress.
    const startCall = mockScheduleDispatch.mock.calls.find((c) =>
      (c[0] as { jobId: string }).jobId.startsWith(`status-maintenance-start--${INCIDENT_ID}`)
    )
    expect(startCall).toBeUndefined()
  })
})
