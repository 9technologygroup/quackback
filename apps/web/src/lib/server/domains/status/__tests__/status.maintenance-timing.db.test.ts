/**
 * Maintenance timing against real Postgres: when a window is dated as
 * started (started_at, migration 0298 and a replay of it over rows the app
 * wrote), and the scheduler's start and complete transitions and sweep.
 * Setup is shared with status.lifecycle.db.test.ts.
 *
 * Event dispatch and the delayed-job scheduler are stubbed; everything else
 * runs for real inside the fixture's always-rolled-back transaction.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testDb } from '@/lib/server/__tests__/db-test-fixture'
import { eq, sql, statusIncidents, statusIncidentUpdates } from '@/lib/server/db'
import { ValidationError } from '@/lib/shared/errors'

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

import { scheduleDispatch } from '@/lib/server/events/scheduler'
import {
  createIncident,
  getStatusIncidentById,
  postIncidentUpdate,
  updateIncident,
} from '../status.service'
import {
  handleMaintenanceComplete,
  handleMaintenanceStart,
  reconcileMaintenanceWindows,
  startMaintenanceNow,
} from '../status.maintenance'
import {
  HOUR,
  author,
  beginTest,
  fixture,
  isRecent,
  raceOnStaleRead,
  scheduleWindow,
  service,
  statements,
} from './status-lifecycle-harness'

describe('status lifecycle (Postgres)', () => {
  beforeEach(async () => {
    expect(fixture.available).toBe(true)
    mockProcessEvent.mockReset().mockResolvedValue(undefined)
    await beginTest()
  })
  afterEach(fixture.rollback)
  afterAll(fixture.close)

  describe('maintenance start time', () => {
    it('holds the planned start until the window starts, and follows a reschedule', async () => {
      const start = new Date(Date.now() + 24 * HOUR)
      const window = await scheduleWindow(start, new Date(start.getTime() + HOUR))
      expect(window.startedAt.getTime()).toBe(start.getTime())

      const later = new Date(start.getTime() + 2 * HOUR)
      const moved = await updateIncident(window.id, {
        scheduledStartAt: later,
        scheduledEndAt: new Date(later.getTime() + HOUR),
      })
      expect(moved.startedAt.getTime()).toBe(later.getTime())
    })

    it('records the real start when the scheduler starts the window', async () => {
      const window = await scheduleWindow(new Date(Date.now() - HOUR), new Date(Date.now() + HOUR))
      await handleMaintenanceStart(window.id)
      const started = await getStatusIncidentById(window.id)
      expect(started.status).toBe('in_progress')
      expect(isRecent(started.startedAt)).toBe(true)
      // Its timeline row is dated at the same instant, to the millisecond.
      expect(started.updates.find((u) => u.status === 'in_progress')?.createdAt).toEqual(
        started.startedAt
      )
    })

    it('records the real start on "Start now" and on a posted in-progress update, and keeps the plan', async () => {
      const plannedStart = new Date(Date.now() + 24 * HOUR)
      const plannedEnd = new Date(plannedStart.getTime() + 2 * HOUR)

      const early = await scheduleWindow(plannedStart, plannedEnd)
      vi.mocked(scheduleDispatch).mockClear()
      const before = Date.now()
      await startMaintenanceNow(early.id)
      const started = await getStatusIncidentById(early.id)
      expect(started.status).toBe('in_progress')
      expect(isRecent(started.startedAt)).toBe(true)
      expect(started.scheduledStartAt?.getTime()).toBe(plannedStart.getTime())
      expect(started.scheduledEndAt?.getTime()).toBe(plannedEnd.getTime())
      // Completion stays armed for the planned end.
      const completion = vi
        .mocked(scheduleDispatch)
        .mock.calls.map(([job]) => job)
        .find((job) => job.handler === '__status_maintenance_complete__')
      expect(completion?.delayMs).toBeLessThanOrEqual(plannedEnd.getTime() - before)
      expect(completion?.delayMs).toBeGreaterThan(plannedEnd.getTime() - before - 60_000)

      const posted = await scheduleWindow(plannedStart, plannedEnd)
      const after = await postIncidentUpdate(
        posted.id,
        { status: 'in_progress', body: 'Starting early.' },
        { principalId: author }
      )
      expect(isRecent(after.startedAt)).toBe(true)
      expect(after.updates.find((u) => u.status === 'in_progress')?.createdAt).toEqual(
        after.startedAt
      )
      expect(after.scheduledStartAt?.getTime()).toBe(plannedStart.getTime())
      expect(after.scheduledEndAt?.getTime()).toBe(plannedEnd.getTime())

      // Both still complete on their own at the planned end.
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(plannedEnd.getTime() + 60_000)
        expect(await reconcileMaintenanceWindows()).toEqual({ started: 0, completed: 2 })
      } finally {
        vi.useRealTimers()
      }
      expect((await getStatusIncidentById(early.id)).status).toBe('completed')
      expect((await getStatusIncidentById(posted.id)).status).toBe('completed')
    })

    it('a window started early and moved back to scheduled holds its plan again', async () => {
      const plannedStart = new Date(Date.now() + 24 * HOUR)
      const window = await scheduleWindow(plannedStart, new Date(plannedStart.getTime() + HOUR))
      await startMaintenanceNow(window.id)

      const moved = await postIncidentUpdate(
        window.id,
        { status: 'scheduled', body: 'Not yet after all.' },
        { principalId: author }
      )
      expect(moved.startedAt.getTime()).toBe(plannedStart.getTime())
      // The plan is still ahead, so it starts on its own then.
      expect(moved.autoStart).toBe(true)
    })

    it('rejects a window that ends before it starts, on create and on update', async () => {
      const start = new Date(Date.now() + 24 * HOUR)
      await expect(scheduleWindow(start, new Date(start.getTime() - HOUR))).rejects.toBeInstanceOf(
        ValidationError
      )

      const window = await scheduleWindow(start, new Date(start.getTime() + HOUR))
      await expect(
        updateIncident(window.id, { scheduledEndAt: new Date(start.getTime() - HOUR) })
      ).rejects.toBeInstanceOf(ValidationError)
      await expect(
        updateIncident(window.id, { scheduledStartAt: new Date(start.getTime() + 2 * HOUR) })
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('migration 0298 dates existing windows by their real or planned start, and a replay changes nothing', async () => {
      const day = 24 * HOUR
      const now = Date.now()
      type Legacy = {
        status: 'scheduled' | 'in_progress' | 'completed'
        created: number
        start: number
        completed?: number
        /** When the window was started (an in_progress update), if it was. */
        begun?: number
      }
      const rows: Record<string, Legacy> = {
        upcoming: { status: 'scheduled', created: now - day, start: now + day },
        planPassed: { status: 'scheduled', created: now - 3 * day, start: now - 2 * day },
        createdUnderWay: { status: 'scheduled', created: now - HOUR, start: now - 2 * HOUR },
        // "Start now" a day ahead of the planned start.
        startedEarlyByHand: {
          status: 'in_progress',
          created: now - 3 * day,
          start: now - day,
          begun: now - 2 * day,
        },
        // Moved straight from scheduled to completed: its completion update is
        // not when it started, or it would have lasted no time at all.
        completedWithoutStart: {
          status: 'completed',
          created: now - 3 * day,
          start: now - 2 * day,
          completed: now - day,
        },
        // Completed (called off) before its planned start: the plan would put
        // started_at after resolved_at, so it keeps its creation time.
        completedBeforePlan: {
          status: 'completed',
          created: now - 3 * day,
          start: now + day,
          completed: now - 2 * day,
        },
        // Completed without starting, then moved to in progress, which kept
        // resolved_at: its start update came after it was resolved, and
        // started_at must not end up after resolved_at.
        reopenedAfterCompleting: {
          status: 'in_progress',
          created: now - 3 * day,
          start: now - 2 * day,
          completed: now - day,
          begun: now - 12 * HOUR,
        },
        // Started early by hand, then moved back to scheduled: a window still
        // scheduled holds its plan, as the app writes it.
        movedBackToScheduled: {
          status: 'scheduled',
          created: now - 3 * day,
          start: now + day,
          begun: now - 2 * day,
        },
      }
      const ids: Record<string, string> = {}
      for (const [name, row] of Object.entries(rows)) {
        const [inserted] = await testDb
          .insert(statusIncidents)
          .values({
            kind: 'maintenance',
            title: name,
            status: row.status,
            impact: 'maintenance',
            scheduledStartAt: new Date(row.start),
            startedAt: new Date(row.created),
            resolvedAt: row.completed ? new Date(row.completed) : null,
          })
          .returning({ id: statusIncidents.id })
        ids[name] = inserted.id
        for (const [status, at] of [
          ['completed', row.completed],
          ['in_progress', row.begun],
        ] as const) {
          if (at === undefined) continue
          await testDb
            .insert(statusIncidentUpdates)
            .values({ incidentId: inserted.id, status, body: status, createdAt: new Date(at) })
        }
      }
      const [incident] = await testDb
        .insert(statusIncidents)
        .values({
          kind: 'incident',
          title: 'incident',
          status: 'investigating',
          scheduledStartAt: new Date(now + day),
          startedAt: new Date(now - day),
        })
        .returning({ id: statusIncidents.id })

      const migration = readFileSync(
        resolve(process.cwd(), 'packages/db/drizzle/0298_status_maintenance_started_at.sql'),
        'utf8'
      )
      await testDb.execute(sql.raw(migration))
      await testDb.execute(sql.raw(migration))

      const startedAt = async (id: string) =>
        (await testDb.query.statusIncidents.findFirst({
          where: eq(statusIncidents.id, id as never),
        }))!.startedAt.getTime()
      expect(await startedAt(ids.upcoming)).toBe(rows.upcoming.start)
      expect(await startedAt(ids.planPassed)).toBe(rows.planPassed.start)
      expect(await startedAt(ids.createdUnderWay)).toBe(rows.createdUnderWay.created)
      expect(await startedAt(ids.startedEarlyByHand)).toBe(rows.startedEarlyByHand.begun)
      expect(await startedAt(ids.completedWithoutStart)).toBe(rows.completedWithoutStart.start)
      expect(await startedAt(ids.completedBeforePlan)).toBe(rows.completedBeforePlan.created)
      expect(await startedAt(ids.reopenedAfterCompleting)).toBe(
        rows.reopenedAfterCompleting.created
      )
      expect(await startedAt(ids.movedBackToScheduled)).toBe(rows.movedBackToScheduled.start)
      expect(await startedAt(incident.id)).toBe(now - day)

      // Then the app runs, and a gap heal replays the migration. Nothing the
      // app wrote in between, new windows or ones from before, may move.
      // The app's clock runs an hour behind the database's here: a start
      // dated by one clock and its timeline row by the other would show.
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(now - HOUR)
        const tick = () => vi.setSystemTime(Date.now() + 60_000)
        const post = (id: string, status: 'in_progress' | 'scheduled' | 'completed') =>
          postIncidentUpdate(id as never, { status, body: status }, { principalId: author })
        const inAnHour = () => new Date(Date.now() + HOUR)
        const anHourAgo = () => new Date(Date.now() - HOUR)

        const byScheduler = await scheduleWindow(anHourAgo(), inAnHour())
        tick()
        await handleMaintenanceStart(byScheduler.id)

        const byPost = await scheduleWindow(inAnHour(), new Date(Date.now() + 2 * HOUR))
        tick()
        await post(byPost.id, 'in_progress')

        const db = await service('Database')
        await createIncident(
          {
            kind: 'maintenance',
            title: 'Upgrade',
            status: 'in_progress',
            body: 'Upgrading.',
            affectedComponents: [{ componentId: db, componentStatus: 'under_maintenance' }],
            scheduledStartAt: anHourAgo(),
            scheduledEndAt: inAnHour(),
            notifySubscribers: false,
          },
          { principalId: author }
        )

        // Completed without starting, then reopened as in progress.
        const reopened = await scheduleWindow(anHourAgo(), inAnHour())
        tick()
        await post(reopened.id, 'completed')
        tick()
        await post(reopened.id, 'in_progress')

        // Started, then moved back to scheduled with its plan behind it.
        const movedBack = await scheduleWindow(anHourAgo(), inAnHour())
        tick()
        await handleMaintenanceStart(movedBack.id)
        tick()
        await post(movedBack.id, 'scheduled')

        // Completed without starting, then its plan corrected.
        const replanned = await scheduleWindow(
          new Date(Date.now() - 3 * HOUR),
          new Date(Date.now() - 2 * HOUR)
        )
        tick()
        await post(replanned.id, 'completed')
        await updateIncident(replanned.id, {
          scheduledStartAt: new Date(Date.now() - 150 * 60_000),
        })

        // Started, moved back to scheduled, then completed from there, by
        // hand and by the scheduler once its end has passed.
        const backThenDone = await scheduleWindow(anHourAgo(), inAnHour())
        const backThenSwept = await scheduleWindow(anHourAgo(), inAnHour())
        tick()
        await handleMaintenanceStart(backThenDone.id)
        await handleMaintenanceStart(backThenSwept.id)
        tick()
        await post(backThenDone.id, 'scheduled')
        await post(backThenSwept.id, 'scheduled')
        tick()
        await post(backThenDone.id, 'completed')
        vi.setSystemTime(Date.now() + 2 * HOUR)
        await handleMaintenanceComplete(backThenSwept.id)

        // A window from before the migration, completed now.
        await post(ids.reopenedAfterCompleting, 'completed')
      } finally {
        vi.useRealTimers()
      }

      const windows = async () =>
        Object.fromEntries(
          (
            await testDb.query.statusIncidents.findMany({
              where: eq(statusIncidents.kind, 'maintenance'),
            })
          ).map((w) => [w.title === 'Upgrade' ? w.id : `${w.title} ${w.id}`, w.startedAt.getTime()])
        )
      const beforeReplay = await windows()
      await testDb.execute(sql.raw(migration))
      expect(await windows()).toEqual(beforeReplay)
    })

    it('a window completed straight from scheduled keeps its planned start, never one after it completed', async () => {
      const plan = new Date(Date.now() - 2 * HOUR)
      const ran = await scheduleWindow(plan, new Date(plan.getTime() + HOUR))
      const completed = await postIncidentUpdate(
        ran.id,
        { status: 'completed', body: 'Done.' },
        { principalId: author }
      )
      expect(completed.startedAt.getTime()).toBe(plan.getTime())
      expect(isRecent(completed.resolvedAt!)).toBe(true)

      // Called off before its planned start: it can't have started later
      // than it finished.
      const future = new Date(Date.now() + 24 * HOUR)
      const calledOff = await scheduleWindow(future, new Date(future.getTime() + HOUR))
      const cancelled = await postIncidentUpdate(
        calledOff.id,
        { status: 'completed', body: 'Called off.' },
        { principalId: author }
      )
      expect(cancelled.startedAt.getTime()).toBeLessThanOrEqual(cancelled.resolvedAt!.getTime())
    })
  })

  describe('the maintenance sweep', () => {
    it('only loads windows that can still need action', async () => {
      const db = await service('Database')
      const past = {
        affectedComponents: [{ componentId: db, componentStatus: 'under_maintenance' as const }],
        scheduledStartAt: new Date(Date.now() - 3 * HOUR),
        scheduledEndAt: new Date(Date.now() - 2 * HOUR),
        notifySubscribers: false,
      }
      const done = await createIncident(
        { ...past, kind: 'maintenance', title: 'Done', status: 'in_progress', body: 'Running.' },
        { principalId: author }
      )
      await handleMaintenanceComplete(done.id)
      const overdue = await createIncident(
        { ...past, kind: 'maintenance', title: 'Overdue', status: 'in_progress', body: 'Running.' },
        { principalId: author }
      )

      statements.length = 0
      expect(await reconcileMaintenanceWindows()).toEqual({ started: 0, completed: 1 })
      expect((await getStatusIncidentById(overdue.id)).status).toBe('completed')

      // The sweep's own read excludes completed windows in SQL, rather than
      // loading every past window and skipping them in code.
      const sweepRead = statements.find(
        (s) => /from "status_incidents"/.test(s.query) && /"scheduled_end_at" <= /.test(s.query)
      )
      expect(sweepRead?.query).toMatch(/\."status" <> \$\d+ and [^)]*"auto_complete"/)
      expect(sweepRead?.params).toContain('completed')
    })

    function dispatched(type: string) {
      return mockProcessEvent.mock.calls.filter(
        ([event]) => (event as { type: string }).type === type
      )
    }

    it('starts a window once when two callers read it as scheduled', async () => {
      const window = await scheduleWindow(new Date(Date.now() - HOUR), new Date(Date.now() + HOUR))
      await raceOnStaleRead(
        () => handleMaintenanceStart(window.id),
        () => handleMaintenanceStart(window.id)
      )

      const started = await getStatusIncidentById(window.id)
      expect(started.status).toBe('in_progress')
      expect(started.updates.filter((u) => u.status === 'in_progress')).toHaveLength(1)
      expect(dispatched('status.maintenance_started')).toHaveLength(1)

      // "Start now" that loses the same race says the window can't be started.
      const other = await scheduleWindow(
        new Date(Date.now() + HOUR),
        new Date(Date.now() + 2 * HOUR)
      )
      let lost: unknown
      await raceOnStaleRead(
        () => startMaintenanceNow(other.id).catch((err: unknown) => void (lost = err)),
        () => startMaintenanceNow(other.id)
      )
      expect(lost).toBeInstanceOf(ValidationError)
      expect(
        (await getStatusIncidentById(other.id)).updates.filter((u) => u.status === 'in_progress')
      ).toHaveLength(1)
    })

    it('completes a window once when two callers read it as running', async () => {
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
      await raceOnStaleRead(
        () => handleMaintenanceComplete(window.id),
        () => handleMaintenanceComplete(window.id)
      )

      const completed = await getStatusIncidentById(window.id)
      expect(completed.status).toBe('completed')
      expect(completed.updates.filter((u) => u.status === 'completed')).toHaveLength(1)
      expect(dispatched('status.maintenance_completed')).toHaveLength(1)
    })

    it('a job left over after its automation was switched off does nothing', async () => {
      // Switching automation off cancels the queued job, but one can still
      // fire: already picked up, or queued under an earlier schedule.
      const scheduled = await scheduleWindow(
        new Date(Date.now() - HOUR),
        new Date(Date.now() + HOUR)
      )
      await updateIncident(scheduled.id, { autoStart: false })
      await handleMaintenanceStart(scheduled.id)
      expect((await getStatusIncidentById(scheduled.id)).status).toBe('scheduled')

      const db = await service('Database')
      const running = await createIncident(
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
      await updateIncident(running.id, { autoComplete: false })
      await handleMaintenanceComplete(running.id)
      expect((await getStatusIncidentById(running.id)).status).toBe('in_progress')
      expect(dispatched('status.maintenance_started')).toEqual([])
      expect(dispatched('status.maintenance_completed')).toEqual([])
    })

    it('"Start now" re-arms completion from the window as it started, not as first read', async () => {
      const start = new Date(Date.now() + 24 * HOUR)
      const window = await scheduleWindow(start, new Date(start.getTime() + HOUR))
      const movedEnd = new Date(start.getTime() + 3 * HOUR)

      // The end moves between "Start now" reading the window and starting it.
      await raceOnStaleRead(
        () => startMaintenanceNow(window.id),
        async () => {
          await updateIncident(window.id, { scheduledEndAt: movedEnd })
          vi.mocked(scheduleDispatch).mockClear()
        }
      )

      const completion = vi
        .mocked(scheduleDispatch)
        .mock.calls.map(([job]) => job)
        .find((job) => job.handler === '__status_maintenance_complete__')
      expect(completion?.jobId).toContain(`-${movedEnd.getTime()}`)
      expect(completion?.delayMs).toBeGreaterThan(movedEnd.getTime() - Date.now() - 60_000)
    })
  })
})
