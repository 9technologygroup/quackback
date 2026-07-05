/**
 * Tests for the CSV import batch pipeline's auto-tag wiring (§I1): every post
 * a commit run creates must also carry the run's batch tag, alongside
 * whatever tags the row itself specified.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PrincipalId } from '@quackback/ids'

const hoisted = vi.hoisted(() => ({
  findFirstPostStatuses: vi.fn(),
  findManyPostStatuses: vi.fn(),
  findManyPostTags: vi.fn(),
  insertValues: vi.fn(),
  onConflictDoNothing: vi.fn(),
}))

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      postStatuses: {
        findFirst: hoisted.findFirstPostStatuses,
        findMany: hoisted.findManyPostStatuses,
      },
      postTags: {
        findMany: hoisted.findManyPostTags,
      },
    },
    insert: (_table: unknown) => ({
      values: (...args: unknown[]) => {
        hoisted.insertValues(...args)
        return { onConflictDoNothing: hoisted.onConflictDoNothing }
      },
    }),
  },
  posts: {},
  postTags: {},
  postTagAssignments: {},
  postStatuses: { isDefault: 'is_default', slug: 'slug' },
  eq: (...args: unknown[]) => ({ eq: args }),
}))

import { processBatch } from '../import-service'
import type { ImportUserResolver } from '../user-resolver'

function fakeResolver(principalId: PrincipalId): ImportUserResolver {
  return {
    resolve: vi.fn().mockResolvedValue(principalId),
    flushPendingCreates: vi.fn().mockResolvedValue(0),
  } as unknown as ImportUserResolver
}

describe('processBatch — batch auto-tag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.findFirstPostStatuses.mockResolvedValue(undefined)
    hoisted.findManyPostStatuses.mockResolvedValue([])
    hoisted.findManyPostTags.mockResolvedValue([])
    hoisted.onConflictDoNothing.mockResolvedValue(undefined)
  })

  it('applies the batch tag to every created post alongside its own tags', async () => {
    const rows = [{ title: 'Row one', content: 'Body one', tags: 'feature' }]

    await processBatch(
      rows,
      'board_1' as never,
      0,
      fakeResolver('principal_fallback' as PrincipalId),
      'principal_fallback' as PrincipalId,
      'post_tag_batch' as never
    )

    // First insert() call is the new tag ("feature"); the assignments insert
    // is the last insert() call and must include the batch tag for the post.
    const assignmentsCall = hoisted.insertValues.mock.calls.at(-1)![0] as {
      postId: string
      tagId: string
    }[]
    expect(assignmentsCall).toEqual(
      expect.arrayContaining([expect.objectContaining({ tagId: 'post_tag_batch' })])
    )
  })

  it('omits the batch tag entirely when none is passed (dry-run / legacy path)', async () => {
    const rows = [{ title: 'Row one', content: 'Body one' }]

    await processBatch(
      rows,
      'board_1' as never,
      0,
      fakeResolver('principal_fallback' as PrincipalId),
      'principal_fallback' as PrincipalId
    )

    // No row tags and no batch tag: the assignments insert never runs, so
    // only the posts insert happens (no tags to create either).
    expect(hoisted.insertValues).toHaveBeenCalledTimes(1)
  })
})
