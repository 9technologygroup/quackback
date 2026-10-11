/**
 * Incident and maintenance lifecycle against real Postgres: the paths whose
 * correctness depends on the SQL (the reconcile query's active set, the
 * soft-delete filters, transaction rollback) rather than on call order.
 * When a maintenance window is dated as started, and the scheduler's
 * transitions, are in status.maintenance-timing.db.test.ts.
 *
 * Event dispatch and the delayed-job scheduler are stubbed; everything else
 * runs for real inside the fixture's always-rolled-back transaction.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createId } from '@quackback/ids'
import { testDb } from '@/lib/server/__tests__/db-test-fixture'
import {
  and,
  eq,
  isNull,
  statusComponentEvents,
  statusIncidentComponents,
  statusIncidents,
} from '@/lib/server/db'
import { ValidationError } from '@/lib/shared/errors'
import { ANONYMOUS_ACTOR } from '@/lib/server/policy/types'

vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

const mockProcessEvent = vi.hoisted(() => vi.fn())
vi.mock('@/lib/server/events/process', () => ({
  processEvent: (...args: unknown[]) => mockProcessEvent(...args),
}))

vi.mock('@/lib/server/events/scheduler', () => ({
  scheduleDispatch: vi.fn().mockResolvedValue(undefined),
  cancelScheduledDispatch: vi.fn().mockResolvedValue(undefined),
}))

import { deleteStatusComponent, setComponentStatus } from '../status.components'
import {
  createIncident,
  createStatusIncidentTemplate,
  deleteIncident,
  findStatusIncidentById,
  getStatusIncidentById,
  listStatusIncidents,
  listStatusIncidentTemplates,
  notifyStatusIncidentPublished,
  postIncidentUpdate,
  reconcileStatusNotifications,
  updateIncident,
} from '../status.service'
import {
  handleMaintenanceComplete,
  handleMaintenanceStart,
  reconcileMaintenanceWindows,
} from '../status.maintenance'
import { getStatusPageSnapshot } from '../status.public'
import {
  HOUR,
  author,
  beginTest,
  fixture,
  isRecent,
  openIncident,
  raceOnStaleRead,
  scheduleWindow,
  service,
  statusOf,
} from './status-lifecycle-harness'

describe('status lifecycle (Postgres)', () => {
  beforeEach(async () => {
    expect(fixture.available).toBe(true)
    mockProcessEvent.mockReset().mockResolvedValue(undefined)
    await beginTest()
  })
  afterEach(fixture.rollback)
  afterAll(fixture.close)

  describe('a service deleted while an incident uses it', () => {
    it('resolving the incident still restores its other services', async () => {
      const api = await service('API')
      const web = await service('Website')
      const incident = await createIncident(
        {
          kind: 'incident',
          title: 'Errors',
          status: 'investigating',
          body: 'Looking into it.',
          affectedComponents: [
            { componentId: api, componentStatus: 'major_outage' },
            { componentId: web, componentStatus: 'partial_outage' },
          ],
          notifySubscribers: false,
        },
        { principalId: author }
      )
      expect(await statusOf(web)).toBe('partial_outage')

      await deleteStatusComponent(api)
      const resolved = await postIncidentUpdate(
        incident.id,
        { status: 'resolved', body: 'Fixed.' },
        { principalId: author }
      )

      expect(resolved.status).toBe('resolved')
      expect(resolved.resolvedAt).not.toBeNull()
      expect(await statusOf(web)).toBe('operational')
    })

    it('leaves the deleted service out of the detail, and keeps its link when the editor saves', async () => {
      const api = await service('API')
      const web = await service('Website')
      const incident = await createIncident(
        {
          kind: 'incident',
          title: 'Errors',
          status: 'investigating',
          body: 'Looking into it.',
          affectedComponents: [
            { componentId: api, componentStatus: 'major_outage' },
            { componentId: web, componentStatus: 'partial_outage' },
          ],
          notifySubscribers: false,
        },
        { principalId: author }
      )
      await deleteStatusComponent(api)

      const detail = await getStatusIncidentById(incident.id)
      expect(detail.affectedComponents.map((c) => c.componentId)).toEqual([web])

      // A stale editor still sends the deleted service back; it is ignored
      // rather than relinked, and its existing link survives as history.
      const saved = await updateIncident(incident.id, {
        title: 'Elevated errors',
        affectedComponents: [
          { componentId: api, componentStatus: 'major_outage' },
          { componentId: web, componentStatus: 'degraded_performance' },
        ],
      })
      expect(saved.affectedComponents).toEqual([
        expect.objectContaining({ componentId: web, componentStatus: 'degraded_performance' }),
      ])
      const links = await testDb.query.statusIncidentComponents.findMany({
        where: eq(statusIncidentComponents.incidentId, incident.id),
      })
      expect(links.map((l) => l.componentId).sort()).toEqual([api, web].sort())
      expect(await statusOf(web)).toBe('degraded_performance')
    })

    it('tells a stale editor whose every service was deleted that, not that none was chosen', async () => {
      const api = await service('API')
      const incident = await openIncident([{ componentId: api, componentStatus: 'major_outage' }])
      await deleteStatusComponent(api)

      await expect(
        updateIncident(incident.id, {
          title: 'Elevated errors',
          affectedComponents: [{ componentId: api, componentStatus: 'major_outage' }],
        })
      ).rejects.toThrow('An affected service has been deleted. Choose the services again.')
    })

    it('maintenance auto-complete still completes the window and restores the rest', async () => {
      const db = await service('Database')
      const api = await service('API')
      const window = await createIncident(
        {
          kind: 'maintenance',
          title: 'Upgrade',
          status: 'in_progress',
          body: 'Upgrading.',
          affectedComponents: [
            { componentId: db, componentStatus: 'under_maintenance' },
            { componentId: api, componentStatus: 'under_maintenance' },
          ],
          scheduledStartAt: new Date(Date.now() - 2 * HOUR),
          scheduledEndAt: new Date(Date.now() - HOUR),
          notifySubscribers: false,
        },
        { principalId: author }
      )
      expect(await statusOf(api)).toBe('under_maintenance')

      await deleteStatusComponent(db)
      await handleMaintenanceComplete(window.id)

      const after = await getStatusIncidentById(window.id)
      expect(after.status).toBe('completed')
      expect(await statusOf(api)).toBe('operational')
    })

    it('templates offer only the services that still exist', async () => {
      const api = await service('API')
      const web = await service('Website')
      await createStatusIncidentTemplate({
        name: 'Outage',
        title: 'Outage',
        body: 'We are investigating.',
        componentIds: [api, web],
      })
      await deleteStatusComponent(api)

      const [template] = await listStatusIncidentTemplates()
      expect(template.componentIds).toEqual([web])
    })
  })

  describe('creating an incident', () => {
    it('rejects a deleted service and writes nothing', async () => {
      const api = await service('API')
      await deleteStatusComponent(api)

      const attempt = createIncident(
        {
          kind: 'incident',
          title: 'Errors',
          status: 'investigating',
          body: 'Looking into it.',
          affectedComponents: [{ componentId: api, componentStatus: 'major_outage' }],
        },
        { principalId: author }
      )
      await expect(attempt).rejects.toBeInstanceOf(ValidationError)
      // Worded for API callers as well as the dashboard: no "refresh the page".
      await expect(attempt).rejects.toThrow(
        'An affected service has been deleted. Choose the services again.'
      )
      expect(await testDb.query.statusIncidents.findMany()).toEqual([])
    })

    it('created already resolved, it is stamped resolved and leaves its services alone', async () => {
      const api = await service('API')
      await setComponentStatus(api, 'degraded_performance', 'manual')

      const resolved = await createIncident(
        {
          kind: 'incident',
          title: 'Blip',
          status: 'resolved',
          body: 'A short blip, already over.',
          affectedComponents: [{ componentId: api, componentStatus: 'major_outage' }],
          notifySubscribers: false,
        },
        { principalId: author }
      )
      expect(resolved.resolvedAt).not.toBeNull()
      expect(isRecent(resolved.resolvedAt!)).toBe(true)
      expect(resolved.startedAt.getTime()).toBeLessThanOrEqual(resolved.resolvedAt!.getTime())
      // It never held the service, so neither outage nor restore applies.
      expect(await statusOf(api)).toBe('degraded_performance')
      expect((await listStatusIncidents({ kind: 'incident', state: 'active' })).items).toEqual([])
      expect(
        (await listStatusIncidents({ kind: 'incident', state: 'resolved' })).items.map((i) => i.id)
      ).toEqual([resolved.id])
    })

    it('a window created already completed is stamped resolved, dated by its plan, and holds nothing', async () => {
      const db = await service('Database')
      const plan = new Date(Date.now() - 3 * HOUR)
      const window = await createIncident(
        {
          kind: 'maintenance',
          title: 'Upgrade',
          status: 'completed',
          body: 'Done last night.',
          affectedComponents: [{ componentId: db, componentStatus: 'under_maintenance' }],
          scheduledStartAt: plan,
          scheduledEndAt: new Date(plan.getTime() + HOUR),
          notifySubscribers: false,
        },
        { principalId: author }
      )
      expect(isRecent(window.resolvedAt!)).toBe(true)
      expect(window.startedAt.getTime()).toBe(plan.getTime())
      expect(await statusOf(db)).toBe('operational')
      expect(await reconcileMaintenanceWindows()).toEqual({ started: 0, completed: 0 })
    })

    it('is atomic: a failure after the incident row is written leaves nothing behind', async () => {
      const api = await service('API')

      // The same service twice violates the link table's primary key, after
      // the incident row itself has already been inserted.
      await expect(
        createIncident(
          {
            kind: 'incident',
            title: 'Errors',
            status: 'investigating',
            body: 'Looking into it.',
            affectedComponents: [
              { componentId: api, componentStatus: 'major_outage' },
              { componentId: api, componentStatus: 'partial_outage' },
            ],
          },
          { principalId: author }
        )
      ).rejects.toThrow()

      expect(await testDb.query.statusIncidents.findMany()).toEqual([])
      expect(await testDb.query.statusIncidentComponents.findMany()).toEqual([])
      expect(await statusOf(api)).toBe('operational')
    })
  })

  describe('deleting an incident', () => {
    it('decides from the row as deleted, not as first read', async () => {
      const window = await scheduleWindow(new Date(Date.now() - HOUR), new Date(Date.now() + HOUR))
      const [link] = window.affectedComponents

      // Read while still scheduled; the scheduler starts it before the
      // delete lands, so the delete must release what it now holds.
      await raceOnStaleRead(
        () => deleteIncident(window.id),
        () => handleMaintenanceStart(window.id)
      )
      expect(await statusOf(link.componentId)).toBe('operational')
    })

    it('releases the services it held, but not ones another open incident still holds', async () => {
      const api = await service('API')
      const web = await service('Website')
      const first = await openIncident([
        { componentId: api, componentStatus: 'major_outage' },
        { componentId: web, componentStatus: 'major_outage' },
      ])
      const second = await openIncident([
        { componentId: api, componentStatus: 'degraded_performance' },
      ])

      await deleteIncident(first.id)
      expect(await statusOf(web)).toBe('operational')
      expect(await statusOf(api)).toBe('degraded_performance')

      await deleteIncident(second.id)
      expect(await statusOf(api)).toBe('operational')
    })

    it('leaves services alone when the row was not holding them', async () => {
      const start = new Date(Date.now() + 24 * HOUR)
      const window = await scheduleWindow(start, new Date(start.getTime() + HOUR))
      const [link] = window.affectedComponents
      await setComponentStatus(link.componentId, 'degraded_performance', 'manual')

      await deleteIncident(window.id)
      expect(await statusOf(link.componentId)).toBe('degraded_performance')

      const api = await service('API')
      const resolved = await openIncident([{ componentId: api, componentStatus: 'major_outage' }])
      await postIncidentUpdate(
        resolved.id,
        { status: 'resolved', body: 'Fixed.' },
        { principalId: author }
      )
      await setComponentStatus(api, 'partial_outage', 'api')

      await deleteIncident(resolved.id)
      expect(await statusOf(api)).toBe('partial_outage')
    })

    it('reads back as missing (null) for the editor, not as an error', async () => {
      const api = await service('API')
      const incident = await openIncident([{ componentId: api, componentStatus: 'major_outage' }])
      expect((await findStatusIncidentById(incident.id))?.id).toBe(incident.id)

      await deleteIncident(incident.id)
      expect(await findStatusIncidentById(incident.id)).toBeNull()
      expect(await findStatusIncidentById(createId('status_incident'))).toBeNull()
    })
  })

  describe('a row that is not holding its services', () => {
    it('leaves a status set since alone when its details are saved', async () => {
      const api = await service('API')
      const incident = await openIncident([{ componentId: api, componentStatus: 'major_outage' }])
      await postIncidentUpdate(
        incident.id,
        { status: 'resolved', body: 'Fixed.' },
        { principalId: author }
      )
      await setComponentStatus(api, 'degraded_performance', 'manual')

      // The editor's autosave always sends the services back.
      await updateIncident(incident.id, {
        title: 'Elevated errors on the API',
        affectedComponents: [{ componentId: api, componentStatus: 'partial_outage' }],
      })
      expect(await statusOf(api)).toBe('degraded_performance')
    })

    it('leaves it alone when a terminal update is posted', async () => {
      const start = new Date(Date.now() + 24 * HOUR)
      const window = await scheduleWindow(start, new Date(start.getTime() + HOUR))
      const [link] = window.affectedComponents
      await setComponentStatus(link.componentId, 'degraded_performance', 'api')

      // Called off before it ever started.
      await postIncidentUpdate(
        window.id,
        { status: 'completed', body: 'Called off.' },
        { principalId: author }
      )
      expect(await statusOf(link.componentId)).toBe('degraded_performance')

      // A further note on a resolved incident.
      const api = await service('API')
      const incident = await openIncident([{ componentId: api, componentStatus: 'major_outage' }])
      await postIncidentUpdate(
        incident.id,
        { status: 'resolved', body: 'Fixed.' },
        { principalId: author }
      )
      await setComponentStatus(api, 'partial_outage', 'manual')
      await postIncidentUpdate(
        incident.id,
        { status: 'resolved', body: 'Root cause: a bad deploy.' },
        { principalId: author }
      )
      expect(await statusOf(api)).toBe('partial_outage')
    })

    it('leaves it alone when the scheduler completes a window that never started', async () => {
      const window = await scheduleWindow(
        new Date(Date.now() - 2 * HOUR),
        new Date(Date.now() - HOUR)
      )
      await updateIncident(window.id, { autoStart: false })
      const [link] = window.affectedComponents
      await setComponentStatus(link.componentId, 'degraded_performance', 'api')

      await handleMaintenanceComplete(window.id)
      expect((await getStatusIncidentById(window.id)).status).toBe('completed')
      expect(await statusOf(link.componentId)).toBe('degraded_performance')
    })

    it('still recomputes a holding row whose services change', async () => {
      const api = await service('API')
      const web = await service('Website')
      const incident = await openIncident([{ componentId: api, componentStatus: 'major_outage' }])

      await updateIncident(incident.id, {
        affectedComponents: [{ componentId: web, componentStatus: 'partial_outage' }],
      })
      expect(await statusOf(api)).toBe('operational')
      expect(await statusOf(web)).toBe('partial_outage')
    })
  })

  describe('reopening', () => {
    it('a resolved incident clears resolvedAt, rejoins the open lists and holds its services again', async () => {
      const api = await service('API')
      const incident = await openIncident([{ componentId: api, componentStatus: 'major_outage' }])
      await postIncidentUpdate(
        incident.id,
        { status: 'resolved', body: 'Fixed.' },
        { principalId: author }
      )
      expect(await statusOf(api)).toBe('operational')
      // Make the first resolution clearly older than any later one.
      await testDb
        .update(statusIncidents)
        .set({ resolvedAt: new Date(Date.now() - 2 * HOUR) })
        .where(eq(statusIncidents.id, incident.id))

      const reopened = await postIncidentUpdate(
        incident.id,
        { status: 'monitoring', body: 'It is back.' },
        { principalId: author }
      )
      expect(reopened.status).toBe('monitoring')
      expect(reopened.resolvedAt).toBeNull()
      expect(await statusOf(api)).toBe('major_outage')
      const open = await listStatusIncidents({ kind: 'incident', state: 'active' })
      expect(open.items.map((i) => i.id)).toEqual([incident.id])
      const snapshot = await getStatusPageSnapshot(ANONYMOUS_ACTOR, { pageDescription: '' })
      expect(snapshot.activeIncidents.map((i) => i.id)).toEqual([incident.id])

      const resolvedAgain = await postIncidentUpdate(
        incident.id,
        { status: 'resolved', body: 'Fixed for real.' },
        { principalId: author }
      )
      expect(resolvedAgain.resolvedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000)
      expect(await statusOf(api)).toBe('operational')
    })

    it('a completed window goes back to holding its services and is not re-completed by the sweep', async () => {
      const db = await service('Database')
      const window = await createIncident(
        {
          kind: 'maintenance',
          title: 'Upgrade',
          status: 'in_progress',
          body: 'Upgrading.',
          affectedComponents: [{ componentId: db, componentStatus: 'under_maintenance' }],
          scheduledStartAt: new Date(Date.now() - 2 * HOUR),
          scheduledEndAt: new Date(Date.now() - HOUR),
          notifySubscribers: false,
        },
        { principalId: author }
      )
      await handleMaintenanceComplete(window.id)
      expect(await statusOf(db)).toBe('operational')

      const reopened = await postIncidentUpdate(
        window.id,
        { status: 'verifying', body: 'Still checking replicas.' },
        { principalId: author }
      )
      expect(reopened.resolvedAt).toBeNull()
      // Its end has passed, so auto-complete would close it again at once.
      expect(reopened.autoComplete).toBe(false)
      expect(await statusOf(db)).toBe('under_maintenance')

      await reconcileMaintenanceWindows()
      expect((await getStatusIncidentById(window.id)).status).toBe('verifying')
    })

    it('a running window moved back to scheduled is not restarted by the sweep', async () => {
      const db = await service('Database')
      const window = await createIncident(
        {
          kind: 'maintenance',
          title: 'Upgrade',
          status: 'in_progress',
          body: 'Upgrading.',
          affectedComponents: [{ componentId: db, componentStatus: 'under_maintenance' }],
          scheduledStartAt: new Date(Date.now() - HOUR),
          scheduledEndAt: new Date(Date.now() + HOUR),
          notifySubscribers: false,
        },
        { principalId: author }
      )

      const moved = await postIncidentUpdate(
        window.id,
        { status: 'scheduled', body: 'Not yet, rescheduling.' },
        { principalId: author }
      )
      expect(moved.autoStart).toBe(false)
      expect(await statusOf(db)).toBe('operational')

      await reconcileMaintenanceWindows()
      expect((await getStatusIncidentById(window.id)).status).toBe('scheduled')
    })
  })

  describe('publishing with "Email subscribers" off', () => {
    it('is never sent, by this version or by an older one rolled back to', async () => {
      const api = await service('API')
      const quiet = await openIncident([{ componentId: api, componentStatus: 'major_outage' }])
      expect(quiet.notifySubscribers).toBe(false)

      const actor = { type: 'service' as const, displayName: 'test' }
      expect(await notifyStatusIncidentPublished(quiet.id, actor)).toBe(false)

      // A row that asked for the email and was never claimed (the process
      // died before the fire-and-forget send) is still picked up.
      const [pending] = await testDb
        .insert(statusIncidents)
        .values({
          kind: 'incident',
          title: 'Pending',
          status: 'investigating',
          createdAt: new Date(Date.now() - HOUR),
        })
        .returning({ id: statusIncidents.id })
      expect(await reconcileStatusNotifications()).toBe(1)
      expect((await getStatusIncidentById(pending.id)).notifiedAt).not.toBeNull()
      const published = mockProcessEvent.mock.calls.filter(
        ([event]) => (event as { type: string }).type === 'status.incident_created'
      )
      expect(published).toHaveLength(1)

      // A version without notify_subscribers sweeps every live row with no
      // notified_at. Rolled back to, or as an old worker mid-deploy, it must
      // still find nothing here to announce.
      const releasedSweep = await testDb
        .select({ id: statusIncidents.id })
        .from(statusIncidents)
        .where(
          and(
            isNull(statusIncidents.notifiedAt),
            eq(statusIncidents.backfilled, false),
            isNull(statusIncidents.deletedAt)
          )
        )
      expect(releasedSweep).toEqual([])
    })

    it('the sweep leaves a row just published to its own claim', async () => {
      // An older version publishing with the box unchecked inserts the row
      // (notify_subscribers defaulting to true) and stamps notified_at a
      // moment later. The sweep must not send in between.
      const unclaimed = (title: string, createdAt: Date) =>
        testDb
          .insert(statusIncidents)
          .values({ kind: 'incident', title, status: 'investigating', createdAt })
          .returning({ id: statusIncidents.id })
      const [justNow] = await unclaimed('Just published', new Date())
      const [lost] = await unclaimed('Claim lost', new Date(Date.now() - 3 * 60_000))

      expect(await reconcileStatusNotifications()).toBe(1)
      expect((await getStatusIncidentById(justNow.id)).notifiedAt).toBeNull()
      expect((await getStatusIncidentById(lost.id)).notifiedAt).not.toBeNull()
    })
  })

  describe('logging a past incident', () => {
    it('rejects one resolved before it started', async () => {
      const api = await service('API')
      const start = new Date(Date.now() - 2 * HOUR)
      await expect(
        createIncident(
          {
            kind: 'incident',
            title: 'Old outage',
            status: 'resolved',
            body: 'It happened.',
            affectedComponents: [{ componentId: api, componentStatus: 'major_outage' }],
            backfill: { startedAt: start, resolvedAt: new Date(start.getTime() - HOUR) },
          },
          { principalId: author }
        )
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('adds history without touching uptime or service status', async () => {
      const api = await service('API')
      const start = new Date(Date.now() - 3 * HOUR)
      const logged = await createIncident(
        {
          kind: 'incident',
          title: 'Old outage',
          status: 'resolved',
          body: 'It happened.',
          affectedComponents: [{ componentId: api, componentStatus: 'major_outage' }],
          backfill: { startedAt: start, resolvedAt: new Date(start.getTime() + HOUR) },
        },
        { principalId: author }
      )

      expect(logged.backfilled).toBe(true)
      expect(logged.startedAt.getTime()).toBe(start.getTime())
      // Its summary is dated at the resolution, not at the moment it was logged.
      expect(logged.updates.map((u) => u.createdAt.getTime())).toEqual([start.getTime() + HOUR])
      expect(await statusOf(api)).toBe('operational')
      // Uptime bars derive from this log; a backfill writes nothing to it.
      expect(
        await testDb.query.statusComponentEvents.findMany({
          where: eq(statusComponentEvents.componentId, api),
        })
      ).toEqual([])
    })

    it('stays history: it is never live, on create or by a later update', async () => {
      const api = await service('API')
      const start = new Date(Date.now() - 3 * HOUR)
      const backfill = { startedAt: start, resolvedAt: new Date(start.getTime() + HOUR) }
      const past = {
        kind: 'incident' as const,
        title: 'Old outage',
        body: 'It happened.',
        affectedComponents: [{ componentId: api, componentStatus: 'major_outage' as const }],
        backfill,
      }

      await expect(
        createIncident({ ...past, status: 'investigating' }, { principalId: author })
      ).rejects.toThrow('A past incident is logged as resolved. Use the "resolved" status.')

      const logged = await createIncident({ ...past, status: 'resolved' }, { principalId: author })
      await expect(
        postIncidentUpdate(
          logged.id,
          { status: 'monitoring', body: 'It is back.' },
          { principalId: author }
        )
      ).rejects.toThrow("A logged past incident can't be reopened. Report a new incident instead.")

      const after = await getStatusIncidentById(logged.id)
      expect(after.status).toBe('resolved')
      expect(after.resolvedAt?.getTime()).toBe(backfill.resolvedAt.getTime())
      expect(after.updates).toHaveLength(1)
      expect(await statusOf(api)).toBe('operational')
      expect((await listStatusIncidents({ kind: 'incident', state: 'active' })).items).toEqual([])

      // A note on it, still resolved, is fine.
      const noted = await postIncidentUpdate(
        logged.id,
        { status: 'resolved', body: 'Root cause: an expired certificate.' },
        { principalId: author }
      )
      expect(noted.updates).toHaveLength(2)
      expect(noted.resolvedAt?.getTime()).toBe(backfill.resolvedAt.getTime())
    })
  })
})
