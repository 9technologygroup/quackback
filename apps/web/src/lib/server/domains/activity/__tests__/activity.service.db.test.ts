/**
 * Activity rows report whether their actor is on the team today. Actor names
 * are read live from the principal, so a teammate who was later removed from
 * the team (and can rename themselves on the portal) no longer counts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createId, type BoardId, type PostId, type PrincipalId } from '@quackback/ids'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import { boards, postActivity, posts, principal } from '@/lib/server/db'

vi.mock('@/lib/server/db', async (original) => ({
  ...(await original<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

import { getActivityForPost } from '../activity.service'

const fixture = await createDbTestFixture({
  probe: async (db) => void (await db.select({ id: postActivity.id }).from(postActivity).limit(0)),
})

describe.skipIf(!fixture.available)('getActivityForPost actor standing (real DB)', () => {
  let postId: PostId
  const actors = {
    teammate: createId('principal') as PrincipalId,
    formerTeammate: createId('principal') as PrincipalId,
    integration: createId('principal') as PrincipalId,
    customer: createId('principal') as PrincipalId,
  }

  beforeEach(async () => {
    await fixture.begin()
    const now = new Date()
    await testDb.insert(principal).values([
      { id: actors.teammate, role: 'admin', type: 'user', displayName: 'Jane', createdAt: now },
      {
        id: actors.formerTeammate,
        role: 'user',
        type: 'user',
        displayName: 'Renamed after leaving',
        createdAt: now,
      },
      {
        id: actors.integration,
        role: 'member',
        type: 'service',
        displayName: 'Linear Integration',
        createdAt: now,
      },
      { id: actors.customer, role: 'user', type: 'user', displayName: 'Ada', createdAt: now },
    ])
    const boardId = createId('board') as BoardId
    await testDb.insert(boards).values({ id: boardId, name: 'Ideas', slug: String(boardId) })
    postId = createId('post') as PostId
    await testDb
      .insert(posts)
      .values({ id: postId, boardId, title: 'Idea', content: '', principalId: actors.customer })
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 9, minute))
    await testDb.insert(postActivity).values([
      { postId, principalId: actors.customer, type: 'post.created', createdAt: at(0) },
      { postId, principalId: actors.teammate, type: 'status.changed', createdAt: at(1) },
      { postId, principalId: actors.formerTeammate, type: 'owner.assigned', createdAt: at(2) },
      {
        postId,
        principalId: actors.integration,
        type: 'external.status_changed',
        createdAt: at(3),
      },
      { postId, principalId: null, type: 'post.restored', createdAt: at(4) },
    ])
  })
  afterEach(fixture.rollback)
  afterAll(fixture.close)

  it('counts current teammates and service principals as on the team, nobody else', async () => {
    const rows = await getActivityForPost(postId)

    expect(rows.map((row) => [row.type, row.actorName, row.actorOnTeam])).toEqual([
      ['post.restored', null, false],
      ['external.status_changed', 'Linear Integration', true],
      ['owner.assigned', 'Renamed after leaving', false],
      ['status.changed', 'Jane', true],
      ['post.created', 'Ada', false],
    ])
  })
})
