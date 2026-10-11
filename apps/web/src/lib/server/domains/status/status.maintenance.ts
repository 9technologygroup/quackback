/**
 * Scheduled maintenance window automation (Status Product Spec §9). Mirrors
 * the changelog scheduled-publish delayed-job pattern (events/scheduler.ts):
 * a BullMQ job fires at the window boundary, and the handler re-fetches
 * current DB state before acting so a stale/duplicate fire (a reschedule
 * left an old job queued, or the reconcile sweep races a live job) is a
 * harmless no-op rather than a double-transition.
 *
 * Depends only on status.components.ts (no cycle with status.service.ts,
 * which calls into this module after creating/updating an incident).
 */
import {
  db,
  eq,
  and,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  min,
  ne,
  notExists,
  or,
  sql,
  statusIncidents,
  statusIncidentComponents,
  statusIncidentUpdates,
  type Database,
  type Transaction,
} from '@/lib/server/db'
import type { StatusIncidentId } from '@quackback/ids'
import { NotFoundError, ValidationError } from '@/lib/shared/errors'
import { logger } from '@/lib/server/logger'
import { scheduleDispatch, cancelScheduledDispatch } from '@/lib/server/events/scheduler'
import type { EventActor } from '@/lib/server/events/dispatch'
import type { StatusMaintenanceStatus } from './status.types'
import {
  reconcileComponentStatuses,
  dispatchStatusEvent,
  holdsComponents,
} from './status.components'

const log = logger.child({ component: 'status-maintenance' })

const SCHEDULER_ACTOR: EventActor = { type: 'service', displayName: 'status-maintenance-scheduler' }

type MaintenanceScheduleFields = {
  id: StatusIncidentId
  kind: string
  status: string
  scheduledStartAt: Date | null
  scheduledEndAt: Date | null
  autoStart: boolean
  autoComplete: boolean
}

/** Included in the job id so a reschedule (either bound changing) produces a
 *  fresh id — the stale job for the old time, if it still fires, is a no-op
 *  once the handler re-checks current state (see module docblock). */
function scheduleHash(
  incident: Pick<MaintenanceScheduleFields, 'scheduledStartAt' | 'scheduledEndAt'>
): string {
  const start = incident.scheduledStartAt?.getTime() ?? 'none'
  const end = incident.scheduledEndAt?.getTime() ?? 'none'
  return `${start}-${end}`
}

function startJobId(incidentId: StatusIncidentId, hash: string): string {
  return `status-maintenance-start--${incidentId}--${hash}`
}
function completeJobId(incidentId: StatusIncidentId, hash: string): string {
  return `status-maintenance-complete--${incidentId}--${hash}`
}

/** Enqueue (or re-enqueue) the delayed start/complete jobs for a maintenance
 *  window. No-op for kind='incident' or once a bound has already passed. */
export async function enqueueMaintenanceJobs(incident: MaintenanceScheduleFields): Promise<void> {
  if (incident.kind !== 'maintenance') return
  const hash = scheduleHash(incident)
  const now = Date.now()

  if (incident.autoStart && incident.status === 'scheduled' && incident.scheduledStartAt) {
    const delayMs = incident.scheduledStartAt.getTime() - now
    if (delayMs > 0) {
      await scheduleDispatch({
        jobId: startJobId(incident.id, hash),
        handler: '__status_maintenance_start__',
        delayMs,
        payload: { incidentId: incident.id },
        actor: SCHEDULER_ACTOR,
      })
    }
  }

  if (
    incident.autoComplete &&
    incident.scheduledEndAt &&
    incident.status !== 'completed' &&
    incident.status !== 'resolved'
  ) {
    const delayMs = incident.scheduledEndAt.getTime() - now
    if (delayMs > 0) {
      await scheduleDispatch({
        jobId: completeJobId(incident.id, hash),
        handler: '__status_maintenance_complete__',
        delayMs,
        payload: { incidentId: incident.id },
        actor: SCHEDULER_ACTOR,
      })
    }
  }
}

/** Best-effort cancel of the current schedule's jobs (e.g. on delete). Any
 *  earlier-hash job left over from a prior reschedule self-guards on fire. */
export async function cancelMaintenanceJobs(incident: MaintenanceScheduleFields): Promise<void> {
  if (incident.kind !== 'maintenance') return
  const hash = scheduleHash(incident)
  await cancelScheduledDispatch(startJobId(incident.id, hash))
  await cancelScheduledDispatch(completeJobId(incident.id, hash))
}

/** The statuses that mean a window has begun. */
const BEGUN_STATUSES: StatusMaintenanceStatus[] = ['in_progress', 'verifying']

/**
 * Dates one window's started_at the way migration 0298 dates existing rows,
 * at the end of a write that changed the window: a window that has begun,
 * unless it is scheduled again, started no earlier than its first
 * in_progress or verifying update; one still scheduled, or that never began,
 * started no earlier than its plan; and neither is moved past resolved_at.
 * Both statements only move started_at later, and the write has usually set
 * it already, so they usually change nothing.
 *
 * A fleet replay of 0298 (a gap heal) runs the same UPDATEs over every row.
 * With each row the app writes settled here, a replay finds nothing to move,
 * including a row from before the migration that the app has touched since.
 * The conditions below must stay the same as the migration's.
 */
export async function settleMaintenanceStart(
  incidentId: StatusIncidentId,
  executor: Database | Transaction
): Promise<void> {
  const begun = and(
    eq(statusIncidentUpdates.incidentId, incidentId),
    inArray(statusIncidentUpdates.status, BEGUN_STATUSES)
  )
  const firstStart = sql`(${executor
    .select({ at: min(statusIncidentUpdates.createdAt) })
    .from(statusIncidentUpdates)
    .where(begun)})`
  const window = and(
    eq(statusIncidents.id, incidentId),
    eq(statusIncidents.kind, 'maintenance'),
    eq(statusIncidents.backfilled, false)
  )

  await executor
    .update(statusIncidents)
    .set({ startedAt: firstStart })
    .where(
      and(
        window,
        ne(statusIncidents.status, 'scheduled'),
        lt(statusIncidents.startedAt, firstStart),
        or(isNull(statusIncidents.resolvedAt), lte(firstStart, statusIncidents.resolvedAt))
      )
    )

  await executor
    .update(statusIncidents)
    .set({ startedAt: sql`${statusIncidents.scheduledStartAt}` })
    .where(
      and(
        window,
        isNotNull(statusIncidents.scheduledStartAt),
        lt(statusIncidents.startedAt, statusIncidents.scheduledStartAt),
        or(
          isNull(statusIncidents.resolvedAt),
          lte(statusIncidents.scheduledStartAt, statusIncidents.resolvedAt)
        ),
        or(
          eq(statusIncidents.status, 'scheduled'),
          notExists(
            executor
              .select({ one: sql`1` })
              .from(statusIncidentUpdates)
              .where(begun)
          )
        )
      )
    )
}

async function affectedComponentIds(
  incidentId: StatusIncidentId,
  executor: Database | Transaction = db
) {
  const links = await executor.query.statusIncidentComponents.findMany({
    where: eq(statusIncidentComponents.incidentId, incidentId),
  })
  return links
}

/** Flip a scheduled window to in_progress + apply component statuses. Guarded
 *  on status==='scheduled' so a stale duplicate job is a no-op. */
export async function handleMaintenanceStart(incidentId: StatusIncidentId): Promise<void> {
  const incident = await db.query.statusIncidents.findFirst({
    where: and(eq(statusIncidents.id, incidentId), isNull(statusIncidents.deletedAt)),
  })
  if (!incident || incident.kind !== 'maintenance' || incident.status !== 'scheduled') return
  if (!incident.scheduledStartAt || incident.scheduledStartAt.getTime() > Date.now()) return

  await beginMaintenance(incident)
}

/** Start a scheduled window now: status, real start, component statuses and
 *  the timeline row in one transaction, then the started event. The planned
 *  window (scheduled_start_at / scheduled_end_at) is left as planned. Returns
 *  the window as started, or null when it was no longer scheduled by the
 *  time it was claimed. */
async function beginMaintenance(incident: { id: StatusIncidentId; title: string }) {
  const incidentId = incident.id
  const started = await db.transaction(async (tx) => {
    // started_at becomes the real start; until now it held the planned one.
    // The update claims the start: it only matches a window still scheduled,
    // so when the start job and the sweep (or "Start now") both read the
    // window as scheduled, the one that commits second matches nothing and
    // stops here instead of starting it again. Its row lock is the one
    // manual lifecycle writes take first (lockIncident in status.service.ts),
    // so one racing this waits for it and then sees the window started.
    const now = new Date()
    const [claimed] = await tx
      .update(statusIncidents)
      .set({ status: 'in_progress', startedAt: now, updatedAt: now })
      .where(
        and(
          eq(statusIncidents.id, incidentId),
          eq(statusIncidents.status, 'scheduled'),
          isNull(statusIncidents.deletedAt)
        )
      )
      .returning()
    if (!claimed) return null

    const links = await affectedComponentIds(incidentId, tx)
    await reconcileComponentStatuses(
      links.map((link) => link.componentId),
      'maintenance',
      incidentId,
      tx
    )

    // Dated at the start it records, so started_at and the window's start
    // update agree exactly (migration 0298 dates a window by that update).
    await tx.insert(statusIncidentUpdates).values({
      incidentId,
      status: 'in_progress',
      body: 'This scheduled maintenance is now in progress.',
      createdBy: null,
      createdAt: now,
    })
    await settleMaintenanceStart(incidentId, tx)
    return { window: claimed, links }
  })
  if (!started) return null

  await dispatchStatusEvent('status.maintenance_started', SCHEDULER_ACTOR, {
    incidentId,
    title: incident.title,
    componentIds: started.links.map((l) => l.componentId),
  }).catch((err) =>
    log.error({ err, incident_id: incidentId }, 'failed to dispatch status.maintenance_started')
  )
  return started.window
}

/** Flip a window to completed + restore the services it was holding.
 *  Guarded on status!=='completed' so a stale duplicate job is a no-op; also
 *  the reconcile sweep's catch-up path for a window whose start was missed
 *  entirely (still 'scheduled') during downtime, which held nothing and so
 *  leaves its services as they are. */
export async function handleMaintenanceComplete(incidentId: StatusIncidentId): Promise<void> {
  const incident = await db.query.statusIncidents.findFirst({
    where: and(eq(statusIncidents.id, incidentId), isNull(statusIncidents.deletedAt)),
  })
  if (!incident || incident.kind !== 'maintenance' || incident.status === 'completed') return
  if (!incident.scheduledEndAt || incident.scheduledEndAt.getTime() > Date.now()) return

  // Status, restored components and the timeline row commit together: a
  // failure can't leave the window completed with its services still under
  // maintenance.
  const links = await db.transaction(async (tx) => {
    // Claimed like a start, against the status just read: of two callers
    // that both read the window as open, only one completes it, and whether
    // it was holding its services is known. A window whose status changed
    // since the read is left for the sweep, which reads it afresh.
    const [claimed] = await tx
      .update(statusIncidents)
      .set({
        status: 'completed',
        resolvedAt: incident.resolvedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(statusIncidents.id, incidentId),
          eq(statusIncidents.status, incident.status),
          isNull(statusIncidents.deletedAt)
        )
      )
      .returning({ id: statusIncidents.id })
    if (!claimed) return null

    const links = await affectedComponentIds(incidentId, tx)
    if (holdsComponents(incident.kind, incident.status)) {
      await reconcileComponentStatuses(
        links.map((link) => link.componentId),
        'maintenance',
        incidentId,
        tx
      )
    }

    await tx.insert(statusIncidentUpdates).values({
      incidentId,
      status: 'completed',
      body: 'This scheduled maintenance is complete.',
      createdBy: null,
    })
    await settleMaintenanceStart(incidentId, tx)
    return links
  })
  if (!links) return

  await dispatchStatusEvent('status.maintenance_completed', SCHEDULER_ACTOR, {
    incidentId,
    title: incident.title,
    componentIds: links.map((l) => l.componentId),
  }).catch((err) =>
    log.error({ err, incident_id: incidentId }, 'failed to dispatch status.maintenance_completed')
  )
}

function notStartable(): ValidationError {
  return new ValidationError(
    'STATUS_MAINTENANCE_NOT_STARTABLE',
    'Only a scheduled maintenance window can be started now'
  )
}

/**
 * Admin "Start now" for a scheduled window. Starts it directly rather than
 * through `handleMaintenanceStart`, whose guard waits for the planned start.
 * The plan is kept: started_at records the real start, the public page still
 * shows the window as it was scheduled, and completion still fires at the
 * planned end. The pending start job is cancelled (it would no-op anyway) and
 * the completion job re-armed, which keeps its id since the plan is unchanged.
 *
 * A window whose end bound has already passed can still be started (it will
 * simply never auto-complete; the admin completes it from the editor).
 */
export async function startMaintenanceNow(incidentId: StatusIncidentId): Promise<void> {
  const incident = await db.query.statusIncidents.findFirst({
    where: and(eq(statusIncidents.id, incidentId), isNull(statusIncidents.deletedAt)),
  })
  if (!incident) throw new NotFoundError('STATUS_INCIDENT_NOT_FOUND', 'Maintenance not found')
  if (incident.kind !== 'maintenance' || incident.status !== 'scheduled') throw notStartable()

  await cancelScheduledDispatch(startJobId(incident.id, scheduleHash(incident)))

  // Started (or completed, or deleted) by something else since the read.
  const started = await beginMaintenance(incident)
  if (!started) throw notStartable()

  // Re-armed from the window as claimed, not as first read.
  await enqueueMaintenanceJobs(started).catch((err) =>
    log.error(
      { err, incident_id: incidentId },
      'failed to re-enqueue maintenance jobs on start-now'
    )
  )
}

/**
 * Boot-time safety net for maintenance windows missed while the process was
 * down (a delayed BullMQ job only fires if something is listening). Finds
 * overdue scheduled starts and overdue completions and runs each handler,
 * which is idempotent via the guards above. Only windows that can still need
 * action are loaded: a completed window is done, so the query leaves out the
 * ever-growing pile of past ones rather than reading them every sweep.
 */
export async function reconcileMaintenanceWindows(): Promise<{
  started: number
  completed: number
}> {
  const now = new Date()
  const due = await db.query.statusIncidents.findMany({
    where: and(
      eq(statusIncidents.kind, 'maintenance'),
      isNull(statusIncidents.deletedAt),
      or(
        and(
          eq(statusIncidents.status, 'scheduled'),
          eq(statusIncidents.autoStart, true),
          lte(statusIncidents.scheduledStartAt, now)
        ),
        and(
          ne(statusIncidents.status, 'completed'),
          eq(statusIncidents.autoComplete, true),
          lte(statusIncidents.scheduledEndAt, now)
        )
      )
    ),
  })

  let started = 0
  let completed = 0
  for (const incident of due) {
    if (
      incident.status === 'scheduled' &&
      incident.autoStart &&
      incident.scheduledStartAt &&
      incident.scheduledStartAt <= now
    ) {
      await handleMaintenanceStart(incident.id)
      started++
    }
    if (
      incident.status !== 'completed' &&
      incident.autoComplete &&
      incident.scheduledEndAt &&
      incident.scheduledEndAt <= now
    ) {
      await handleMaintenanceComplete(incident.id)
      completed++
    }
  }
  return { started, completed }
}
