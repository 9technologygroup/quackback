/**
 * When an incident's details were last edited (details_edited_at, migration
 * 0300), against real Postgres. The status feed announces an edit that comes
 * after the latest update, so only a change a feed item shows may stamp it:
 * the title, the scheduled window, or the affected services. The editor
 * autosaves its whole sidebar, so a save that changes none of those, or only
 * the automation switches or the impact, must leave it as it was.
 *
 * Event dispatch and the delayed-job scheduler are stubbed; everything else
 * runs for real inside the fixture's always-rolled-back transaction (setup
 * shared with status.lifecycle.db.test.ts).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SegmentId, StatusIncidentId } from '@quackback/ids'
import { testDb } from '@/lib/server/__tests__/db-test-fixture'
import { eq, statusIncidents } from '@/lib/server/db'

vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))
vi.mock('@/lib/server/events/process', () => ({
  processEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/server/events/scheduler', () => ({
  scheduleDispatch: vi.fn().mockResolvedValue(undefined),
  cancelScheduledDispatch: vi.fn().mockResolvedValue(undefined),
}))

import { ANONYMOUS_ACTOR } from '@/lib/server/policy/types'
import { createStatusComponent, deleteStatusComponent } from '../status.components'
import {
  createIncident,
  getStatusIncidentById,
  postIncidentUpdate,
  updateIncident,
} from '../status.service'
import { listStatusFeedItems } from '../status.public'
import {
  HOUR,
  author,
  beginTest,
  fixture,
  scheduleWindow,
  service,
} from './status-lifecycle-harness'

async function detailsEditedAt(id: StatusIncidentId) {
  const row = await testDb.query.statusIncidents.findFirst({
    where: eq(statusIncidents.id, id),
    columns: { detailsEditedAt: true },
  })
  return row?.detailsEditedAt
}

describe('details edited (Postgres)', () => {
  beforeEach(async () => {
    expect(fixture.available).toBe(true)
    await beginTest()
  })
  afterEach(fixture.rollback)
  afterAll(fixture.close)

  async function window() {
    const start = new Date(Date.now() + 24 * HOUR)
    const created = await scheduleWindow(start, new Date(start.getTime() + HOUR))
    // Everything the editor's sidebar sends back on an autosave.
    const unchanged = {
      title: created.title,
      scheduledStartAt: created.scheduledStartAt,
      scheduledEndAt: created.scheduledEndAt,
      affectedComponents: created.affectedComponents.map((c) => ({
        componentId: c.componentId,
        componentStatus: c.componentStatus,
      })),
    }
    return { id: created.id, start, unchanged }
  }

  /** A window on two services, as the editor would send it back, with no
   *  edit recorded yet. */
  async function windowWith(componentId: Awaited<ReturnType<typeof service>>) {
    const w = await window()
    const affectedComponents = [
      ...w.unchanged.affectedComponents,
      { componentId, componentStatus: 'under_maintenance' as const },
    ]
    await updateIncident(w.id, { ...w.unchanged, affectedComponents })
    await testDb
      .update(statusIncidents)
      .set({ detailsEditedAt: null })
      .where(eq(statusIncidents.id, w.id))
    return { ...w, unchanged: { ...w.unchanged, affectedComponents } }
  }

  it('is left unset by an autosave that changes nothing a reader sees', async () => {
    const { id, unchanged } = await window()
    await updateIncident(id, unchanged)
    await updateIncident(id, { ...unchanged, autoStart: false, autoComplete: false })
    expect(await detailsEditedAt(id)).toBeNull()
    // The row itself was written all the same.
    expect((await getStatusIncidentById(id)).autoStart).toBe(false)
  })

  it('is stamped by a new title, a moved window, or other services', async () => {
    const edits = [
      (w: Awaited<ReturnType<typeof window>>) => ({ ...w.unchanged, title: 'Database upgrade' }),
      (w: Awaited<ReturnType<typeof window>>) => ({
        ...w.unchanged,
        scheduledEndAt: new Date(w.start.getTime() + 2 * HOUR),
      }),
      (w: Awaited<ReturnType<typeof window>>) => ({
        ...w.unchanged,
        affectedComponents: w.unchanged.affectedComponents.map((c) => ({
          ...c,
          componentStatus: 'major_outage' as const,
        })),
      }),
    ]
    for (const edit of edits) {
      const w = await window()
      await updateIncident(w.id, edit(w))
      expect(await detailsEditedAt(w.id)).toBeInstanceOf(Date)
    }

    const added = await window()
    const api = await service('API')
    await updateIncident(added.id, {
      ...added.unchanged,
      affectedComponents: [
        ...added.unchanged.affectedComponents,
        { componentId: api, componentStatus: 'under_maintenance' },
      ],
    })
    expect(await detailsEditedAt(added.id)).toBeInstanceOf(Date)
  })

  it('is stamped when a service is taken off', async () => {
    const w = await windowWith(await service('API'))
    await updateIncident(w.id, {
      ...w.unchanged,
      affectedComponents: w.unchanged.affectedComponents.slice(0, 1),
    })
    expect(await detailsEditedAt(w.id)).toBeInstanceOf(Date)
  })

  it('is left unset by an autosave that sends back a service deleted since', async () => {
    // The link to the deleted service stays as history, so nothing changed.
    const api = await service('API')
    const w = await windowWith(api)
    await deleteStatusComponent(api)
    await updateIncident(w.id, w.unchanged)
    expect(await detailsEditedAt(w.id)).toBeNull()
  })

  it('counts only services every viewer of the page can see', async () => {
    // The stamp is the same for every reader, and the feed's edit item shows
    // only the services a reader can see. A change to a service gated to
    // some segments would announce, to everyone else, a change they can't
    // see and when it happened.
    const gatedTo = async (name: string) =>
      (await createStatusComponent({ name, segmentIds: ['segment_staff' as SegmentId] })).id
    const gated = await gatedTo('Internal admin')
    const changes = [
      (w: Awaited<ReturnType<typeof windowWith>>) =>
        w.unchanged.affectedComponents.map((c) =>
          c.componentId === gated ? { ...c, componentStatus: 'major_outage' as const } : c
        ),
      (w: Awaited<ReturnType<typeof windowWith>>) =>
        w.unchanged.affectedComponents.filter((c) => c.componentId !== gated),
      async (w: Awaited<ReturnType<typeof windowWith>>) => [
        ...w.unchanged.affectedComponents,
        { componentId: await gatedTo('Billing jobs'), componentStatus: 'major_outage' as const },
      ],
    ]
    for (const change of changes) {
      const w = await windowWith(gated)
      await updateIncident(w.id, { ...w.unchanged, affectedComponents: await change(w) })
      expect(await detailsEditedAt(w.id)).toBeNull()
    }

    // The same change to a service everyone can see is announced.
    const w = await windowWith(gated)
    await updateIncident(w.id, {
      ...w.unchanged,
      affectedComponents: w.unchanged.affectedComponents.map((c) =>
        c.componentId === gated ? c : { ...c, componentStatus: 'major_outage' as const }
      ),
    })
    expect(await detailsEditedAt(w.id)).toBeInstanceOf(Date)
  })

  describe('in the status feed', () => {
    it('is not newer than an update posted after the edit, whatever the app clock says', async () => {
      // The feed compares the stamp with update times the database dates, so
      // the stamp takes the database's time too: an app clock running ahead
      // must not make an edit look newer than the update that followed it.
      const w = await window()
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(Date.now() + HOUR)
        await updateIncident(w.id, { ...w.unchanged, title: 'Database upgrade' })
      } finally {
        vi.useRealTimers()
      }
      await postIncidentUpdate(
        w.id,
        { status: 'scheduled', body: 'New title, same plan.' },
        { principalId: author }
      )

      const item = (await listStatusFeedItems(ANONYMOUS_ACTOR, 50)).find((i) => i.id === w.id)
      const latestUpdateAt = Math.max(...(item?.updates ?? []).map((u) => u.createdAt.getTime()))
      expect(item?.detailsEditedAt?.getTime()).toBeLessThanOrEqual(latestUpdateAt)
    })

    it('is the edit a feed item carries, and a logged past incident has none', async () => {
      // A logged past incident is written now, but its update is dated at its
      // resolution: its row's own write is not an edit to announce.
      const resolvedAt = new Date(Date.now() - 48 * HOUR)
      const logged = await createIncident(
        {
          kind: 'incident',
          title: 'Login delays',
          status: 'resolved',
          body: 'Fixed.',
          affectedComponents: [
            { componentId: await service('Login'), componentStatus: 'major_outage' },
          ],
          backfill: { startedAt: new Date(resolvedAt.getTime() - HOUR), resolvedAt },
        },
        { principalId: author }
      )
      const w = await window()
      await updateIncident(w.id, { ...w.unchanged, title: 'Database upgrade' })

      const items = await listStatusFeedItems(ANONYMOUS_ACTOR, 50)
      expect(items.find((i) => i.id === logged.id)?.detailsEditedAt).toBeNull()
      expect(items.find((i) => i.id === w.id)?.detailsEditedAt).toEqual(await detailsEditedAt(w.id))
    })
  })
})
