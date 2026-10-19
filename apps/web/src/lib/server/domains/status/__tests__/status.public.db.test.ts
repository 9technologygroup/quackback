/**
 * Execution-level tests for the public status reads that page past the
 * snapshot: incident history and the RSS feed's items.
 *
 * - History resumes after the page's recent window instead of starting again
 *   from the newest incident, which listed the first 14 days twice.
 * - The feed carries open incidents and scheduled or in-progress maintenance,
 *   not only resolved history, newest activity first.
 * - A visitor who can't see some of an incident's services is shown the
 *   impact of the ones they can see, not one raised by the hidden ones.
 *
 * Runs the real queries against the real database, inside the test-DB
 * fixture's always-rolled-back transaction: each test seeds its own rows, and
 * no other test file ever sees them (some count every incident there is).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import {
  statusComponents,
  statusIncidents,
  statusIncidentUpdates,
  statusIncidentComponents,
} from '@/lib/server/db'

vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

import {
  createId,
  type PrincipalId,
  type SegmentId,
  type StatusComponentId,
  type StatusIncidentId,
} from '@quackback/ids'
import { ANONYMOUS_ACTOR, type Actor } from '@/lib/server/policy/types'
import {
  getPublicStatusIncident,
  getStatusPageSnapshot,
  listIncidentHistory,
  listStatusFeedItems,
  statusIncidentLastActivityAt,
} from '../status.public'

const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
const ago = (days: number) => new Date(now - days * DAY)

const COMPONENT = createId('status_component') as StatusComponentId
const GATED_COMPONENT = createId('status_component') as StatusComponentId
const RECENT_INCIDENT = createId('status_incident') as StatusIncidentId
const OLD_INCIDENT = createId('status_incident') as StatusIncidentId
const RECENT_MAINTENANCE = createId('status_incident') as StatusIncidentId
const OPEN_INCIDENT = createId('status_incident') as StatusIncidentId
const SCHEDULED_MAINTENANCE = createId('status_incident') as StatusIncidentId
const GATED_INCIDENT = createId('status_incident') as StatusIncidentId
// Resolved long ago, so the page and feed assertions below never list them.
const MIXED_INCIDENT = createId('status_incident') as StatusIncidentId
const OVERRIDDEN_INCIDENT = createId('status_incident') as StatusIncidentId
const IMPACT_ROWS = [MIXED_INCIDENT, OVERRIDDEN_INCIDENT]
const MINE = [
  RECENT_INCIDENT,
  OLD_INCIDENT,
  RECENT_MAINTENANCE,
  OPEN_INCIDENT,
  SCHEDULED_MAINTENANCE,
  GATED_INCIDENT,
]

const fixture = await createDbTestFixture({
  probe: async (db) => {
    await db
      .select({ id: statusIncidents.id, edited: statusIncidents.detailsEditedAt })
      .from(statusIncidents)
      .limit(0)
  },
})

const mine = (ids: string[]) => ids.filter((id) => MINE.includes(id as StatusIncidentId))

describe.skipIf(!fixture.available)(
  'public status reads past the snapshot (execution-level)',
  () => {
    beforeEach(async () => {
      await fixture.begin()
      await testDb.insert(statusComponents).values([
        { id: COMPONENT, name: `pub-${runSuffix}` },
        // Visible only to a segment an anonymous visitor is never in.
        { id: GATED_COMPONENT, name: `gated-${runSuffix}`, segmentIds: ['segment_nobody'] },
      ])

      const incident = (
        id: StatusIncidentId,
        kind: 'incident' | 'maintenance',
        status: string,
        startedAt: Date,
        resolvedAt: Date | null,
        scheduled?: { start: Date; end: Date }
      ) => ({
        id,
        kind,
        status: status as never,
        title: `pub-${runSuffix}-${status}`,
        impact: (kind === 'maintenance' ? 'maintenance' : 'major') as never,
        startedAt,
        resolvedAt,
        scheduledStartAt: scheduled?.start ?? null,
        scheduledEndAt: scheduled?.end ?? null,
      })
      await testDb.insert(statusIncidents).values([
        incident(RECENT_INCIDENT, 'incident', 'resolved', ago(2), ago(1.9)),
        incident(OLD_INCIDENT, 'incident', 'resolved', ago(20), ago(19.9)),
        incident(RECENT_MAINTENANCE, 'maintenance', 'completed', ago(3), ago(2.9)),
        incident(OPEN_INCIDENT, 'incident', 'investigating', ago(0.1), null),
        incident(SCHEDULED_MAINTENANCE, 'maintenance', 'scheduled', ago(0.5), null, {
          start: new Date(now + 2 * DAY),
          end: new Date(now + 2 * DAY + 2 * 60 * 60 * 1000),
        }),
        incident(GATED_INCIDENT, 'incident', 'investigating', ago(0.05), null),
      ])

      await testDb.insert(statusIncidentComponents).values(
        MINE.map((id) => ({
          incidentId: id,
          componentId: id === GATED_INCIDENT ? GATED_COMPONENT : COMPONENT,
          componentStatus: 'partial_outage' as const,
        }))
      )

      // One update per row, written when the row last changed.
      const lastChange: Record<string, Date> = {
        [RECENT_INCIDENT]: ago(1.9),
        [OLD_INCIDENT]: ago(19.9),
        [RECENT_MAINTENANCE]: ago(2.9),
        [OPEN_INCIDENT]: ago(0.1),
        [SCHEDULED_MAINTENANCE]: ago(0.5),
        [GATED_INCIDENT]: ago(0.05),
      }
      await testDb.insert(statusIncidentUpdates).values(
        MINE.map((id) => ({
          incidentId: id,
          status: 'investigating' as never,
          body: 'update',
          createdAt: lastChange[id],
        }))
      )

      // API degraded for everyone, plus a major outage on a gated service: the
      // stored impact is critical because of the service most visitors can't see.
      await testDb.insert(statusIncidents).values([
        {
          ...incident(MIXED_INCIDENT, 'incident', 'resolved', ago(400), ago(399)),
          impact: 'critical',
        },
        // An admin set the impact by hand, below what the services suggest.
        {
          ...incident(OVERRIDDEN_INCIDENT, 'incident', 'resolved', ago(400), ago(399)),
          impact: 'minor',
          impactOverride: true,
        },
      ])
      await testDb.insert(statusIncidentComponents).values(
        IMPACT_ROWS.flatMap((id) => [
          {
            incidentId: id,
            componentId: COMPONENT,
            componentStatus:
              id === MIXED_INCIDENT
                ? ('degraded_performance' as const)
                : ('partial_outage' as const),
          },
          {
            incidentId: id,
            componentId: GATED_COMPONENT,
            componentStatus: 'major_outage' as const,
          },
        ])
      )
    })
    afterEach(fixture.rollback)
    afterAll(fixture.close)

    it('resumes incident history after the incidents the page already lists', async () => {
      const snapshot = await getStatusPageSnapshot(ANONYMOUS_ACTOR, { pageDescription: null })
      const recentIds = snapshot.recentIncidents.flatMap((d) => d.incidents.map((i) => i.id))
      expect(mine(recentIds)).toEqual([RECENT_INCIDENT])
      expect(snapshot.recentWindow.days).toBe(14)

      const history = await listIncidentHistory(ANONYMOUS_ACTOR, {
        limit: 100,
        before: snapshot.recentWindow.start,
      })
      // The 14-day incident is not repeated; older incidents follow, and a
      // window completed this week (never in the recent list) is still shown.
      expect(mine(history.items.map((i) => i.id))).toEqual([RECENT_MAINTENANCE, OLD_INCIDENT])
    })

    it('keeps the recent window where it was when the page is read again', async () => {
      // The page's history query is keyed on the window start, so a refetch a
      // minute later must not move it (that reset an expanded history).
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(new Date('2026-10-11T15:30:00.000Z'))
        const first = await getStatusPageSnapshot(ANONYMOUS_ACTOR, { pageDescription: null })
        vi.setSystemTime(new Date('2026-10-11T15:31:00.000Z'))
        const second = await getStatusPageSnapshot(ANONYMOUS_ACTOR, { pageDescription: null })
        expect(second.recentWindow.start).toEqual(first.recentWindow.start)
        // It still covers at least the 14 days the page says it does.
        expect(first.recentWindow.start).toEqual(new Date('2026-09-27T00:00:00.000Z'))
      } finally {
        vi.useRealTimers()
      }
    })

    it('without a cutoff, history still lists every resolved item', async () => {
      const history = await listIncidentHistory(ANONYMOUS_ACTOR, { limit: 100 })
      expect(mine(history.items.map((i) => i.id))).toEqual([
        RECENT_INCIDENT,
        RECENT_MAINTENANCE,
        OLD_INCIDENT,
      ])
    })

    it('feeds open incidents and scheduled maintenance with resolved history, newest activity first', async () => {
      const items = await listStatusFeedItems(ANONYMOUS_ACTOR, 50)
      // The gated incident's only component is hidden from this visitor.
      expect(mine(items.map((i) => i.id))).toEqual([
        OPEN_INCIDENT,
        SCHEDULED_MAINTENANCE,
        RECENT_INCIDENT,
        RECENT_MAINTENANCE,
        OLD_INCIDENT,
      ])
      const activity = items.map((i) => statusIncidentLastActivityAt(i).getTime())
      expect(activity).toEqual([...activity].sort((a, b) => b - a))
    })

    it('keeps every open incident and window in the feed, however many resolved ones are newer', async () => {
      // The limit counts resolved history; what is happening now always stays.
      const items = await listStatusFeedItems(ANONYMOUS_ACTOR, 1)
      expect(mine(items.map((i) => i.id))).toEqual(
        expect.arrayContaining([OPEN_INCIDENT, SCHEDULED_MAINTENANCE])
      )
    })

    it('says when each feed item was last edited, for edits that post no update', async () => {
      // A reschedule through the editor changes the details, not the timeline.
      const edited = ago(0.2)
      await testDb
        .update(statusIncidents)
        .set({ detailsEditedAt: edited })
        .where(eq(statusIncidents.id, SCHEDULED_MAINTENANCE))
      const items = await listStatusFeedItems(ANONYMOUS_ACTOR, 50)
      expect(items.find((i) => i.id === SCHEDULED_MAINTENANCE)?.detailsEditedAt).toEqual(edited)
      // A row with no such edit carries none, whenever it was last written.
      expect(items.find((i) => i.id === OPEN_INCIDENT)?.detailsEditedAt).toBeNull()
    })

    it('fills the resolved part of the feed with what the viewer can see', async () => {
      // Three incidents on a gated service are the newest resolved ones, then
      // one the visitor can see. The limit must count only visible incidents.
      const gated = [1, 2, 3].map(() => createId('status_incident') as StatusIncidentId)
      const visible = createId('status_incident') as StatusIncidentId
      const later = (days: number) => new Date(now + days * DAY)
      await testDb.insert(statusIncidents).values(
        [...gated, visible].map((id, n) => ({
          id,
          kind: 'incident' as const,
          status: 'resolved' as never,
          title: `pub-${runSuffix}-limit-${n}`,
          impact: 'major' as never,
          startedAt: later(10),
          // Resolving writes the row, so it was last written when it resolved.
          resolvedAt: later(id === visible ? 10.5 : 11 + n),
          updatedAt: later(id === visible ? 10.5 : 11 + n),
        }))
      )
      await testDb.insert(statusIncidentComponents).values(
        [...gated, visible].map((id) => ({
          incidentId: id,
          componentId: id === visible ? COMPONENT : GATED_COMPONENT,
          componentStatus: 'partial_outage' as const,
        }))
      )
      const forVisitor = (await listStatusFeedItems(ANONYMOUS_ACTOR, 3)).map((i) => i.id)
      expect(forVisitor).toContain(visible)
      // Never wider than the page: the gated incidents stay hidden.
      expect(forVisitor.filter((id) => gated.includes(id))).toEqual([])

      const member: Actor = {
        principalId: createId('principal') as PrincipalId,
        role: 'user',
        principalType: 'user',
        segmentIds: new Set(['segment_nobody' as SegmentId]),
      }
      const forMember = (await listStatusFeedItems(member, 3)).map((i) => i.id)
      expect(forMember).toEqual(expect.arrayContaining(gated))
      expect(forMember).not.toContain(visible)
    })

    it('feeds an older resolved incident edited since, however many resolved after it', async () => {
      // Three incidents resolved after it, but it was edited (or updated) last:
      // its newest item must still reach readers.
      const newer = [1, 2, 3].map(() => createId('status_incident') as StatusIncidentId)
      const edited = createId('status_incident') as StatusIncidentId
      const later = (days: number) => new Date(now + days * DAY)
      const rows = [
        { id: edited, resolvedAt: later(20), updatedAt: later(30) },
        ...newer.map((id, n) => ({ id, resolvedAt: later(21 + n), updatedAt: later(21 + n) })),
      ]
      await testDb.insert(statusIncidents).values(
        rows.map((row, n) => ({
          ...row,
          kind: 'incident' as const,
          status: 'resolved' as never,
          title: `pub-${runSuffix}-edited-${n}`,
          impact: 'major' as never,
          startedAt: later(19),
        }))
      )
      await testDb.insert(statusIncidentComponents).values(
        rows.map((row) => ({
          incidentId: row.id,
          componentId: COMPONENT,
          componentStatus: 'partial_outage' as const,
        }))
      )
      const ids = (await listStatusFeedItems(ANONYMOUS_ACTOR, 2)).map((i) => i.id)
      expect(ids).toContain(edited)
    })

    it('reads a link that is not an incident id as not found, not an error', async () => {
      expect(
        await getPublicStatusIncident(ANONYMOUS_ACTOR, 'history' as StatusIncidentId)
      ).toBeNull()
      expect(
        await getPublicStatusIncident(
          ANONYMOUS_ACTOR,
          'status_component_01h455vb4pex5vsknk084sn02q' as StatusIncidentId
        )
      ).toBeNull()
    })

    describe('impact, for a visitor who sees only some services', () => {
      const insider: Actor = {
        principalId: createId('principal') as PrincipalId,
        role: 'user',
        principalType: 'user',
        segmentIds: new Set(['segment_nobody' as SegmentId]),
      }

      it('comes from the services the visitor can see', async () => {
        const seen = await getPublicStatusIncident(ANONYMOUS_ACTOR, MIXED_INCIDENT)
        expect(seen?.affectedComponents.map((c) => c.id)).toEqual([COMPONENT])
        expect(seen?.impact).toBe('minor')
      })

      it("stays the incident's own for a visitor who sees every service", async () => {
        const seen = await getPublicStatusIncident(insider, MIXED_INCIDENT)
        expect(seen?.affectedComponents).toHaveLength(2)
        expect(seen?.impact).toBe('critical')
      })

      it('keeps an admin override that is lower than the visible services suggest', async () => {
        expect((await getPublicStatusIncident(ANONYMOUS_ACTOR, OVERRIDDEN_INCIDENT))?.impact).toBe(
          'minor'
        )
      })
    })
  }
)
