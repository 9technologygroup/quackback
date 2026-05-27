/**
 * Public changelog views must not leak non-published posts.
 *
 * A team member can link a post to a published changelog entry — but
 * the post itself may be in any moderation state (pending review,
 * spam, archived, closed). Only `published` posts may be exposed
 * through the public changelog API; everything else must be filtered
 * out before the response leaves the server.
 *
 * The earlier filter only excluded `deletedAt` rows. This file pins
 * the full moderation-state contract so the regression can't return.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChangelogId, PostId } from '@quackback/ids'

const mockEntryFindFirst = vi.fn()
const mockEntryFindMany = vi.fn()
const mockLinkedPostsFindMany = vi.fn()
const mockStatusesFindMany = vi.fn()

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      changelogEntries: {
        findFirst: (...args: unknown[]) => mockEntryFindFirst(...args),
        findMany: (...args: unknown[]) => mockEntryFindMany(...args),
      },
      changelogEntryPosts: {
        findMany: (...args: unknown[]) => mockLinkedPostsFindMany(...args),
      },
      postStatuses: {
        findMany: (...args: unknown[]) => mockStatusesFindMany(...args),
      },
    },
  },
  changelogEntries: { id: 'id', publishedAt: 'published_at', deletedAt: 'deleted_at' },
  changelogEntryPosts: { changelogEntryId: 'changelog_entry_id' },
  postStatuses: { id: 'id' },
  eq: vi.fn((col, val) => ({ kind: 'eq', col, val })),
  and: vi.fn((...args: unknown[]) => ({ kind: 'and', args })),
  or: vi.fn((...args: unknown[]) => ({ kind: 'or', args })),
  isNull: vi.fn((col) => ({ kind: 'isNull', col })),
  isNotNull: vi.fn((col) => ({ kind: 'isNotNull', col })),
  lt: vi.fn((col, val) => ({ kind: 'lt', col, val })),
  lte: vi.fn((col, val) => ({ kind: 'lte', col, val })),
  desc: vi.fn((col) => ({ kind: 'desc', col })),
  inArray: vi.fn((col, vals) => ({ kind: 'inArray', col, vals })),
}))

type LinkedPostAudience =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'team' }
  | { kind: 'segments'; segmentIds: string[] }

function audienceToView(
  audience: LinkedPostAudience
): 'anonymous' | 'authenticated' | 'team' | 'segments' {
  switch (audience.kind) {
    case 'public':
      return 'anonymous'
    case 'authenticated':
      return 'authenticated'
    case 'team':
      return 'team'
    case 'segments':
      return 'segments'
  }
}

function linkedPost(opts: {
  id: string
  moderationState: 'published' | 'pending' | 'spam' | 'archived' | 'closed'
  deletedAt?: Date | null
  audience?: LinkedPostAudience
}) {
  const audience = opts.audience ?? { kind: 'public' }
  const view = audienceToView(audience)
  return {
    changelogEntryId: 'cl_1' as ChangelogId,
    post: {
      id: opts.id as PostId,
      title: `Post ${opts.id}`,
      voteCount: 0,
      boardId: 'brd_1',
      statusId: null,
      deletedAt: opts.deletedAt ?? null,
      moderationState: opts.moderationState,
      board: {
        slug: 'feedback',
        access: {
          view,
          comment: view,
          submit: view,
          segmentIds: audience.kind === 'segments' ? audience.segmentIds : [],
          approval: { posts: false, comments: false },
        },
      },
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockStatusesFindMany.mockResolvedValue([])
})

describe('getPublicChangelogById — moderation state filter', () => {
  it('returns only published linked posts; pending/spam/archived/closed are hidden', async () => {
    const { getPublicChangelogById } = await import('../changelog.public')
    mockEntryFindFirst.mockResolvedValueOnce({
      id: 'cl_1' as ChangelogId,
      title: 'Release Notes',
      content: '',
      contentJson: null,
      publishedAt: new Date('2026-01-01'),
    })
    mockLinkedPostsFindMany.mockResolvedValueOnce([
      linkedPost({ id: 'post_pub', moderationState: 'published' }),
      linkedPost({ id: 'post_pen', moderationState: 'pending' }),
      linkedPost({ id: 'post_spam', moderationState: 'spam' }),
      linkedPost({ id: 'post_arch', moderationState: 'archived' }),
      linkedPost({ id: 'post_closed', moderationState: 'closed' }),
    ])

    const result = await getPublicChangelogById('cl_1' as ChangelogId)

    const visibleIds = result.linkedPosts.map((p) => p.id)
    expect(visibleIds).toEqual(['post_pub'])
  })

  it('hides linked posts that are deleted even if their moderationState is published', async () => {
    const { getPublicChangelogById } = await import('../changelog.public')
    mockEntryFindFirst.mockResolvedValueOnce({
      id: 'cl_1' as ChangelogId,
      title: 'Release Notes',
      content: '',
      contentJson: null,
      publishedAt: new Date('2026-01-01'),
    })
    mockLinkedPostsFindMany.mockResolvedValueOnce([
      linkedPost({ id: 'post_live', moderationState: 'published' }),
      linkedPost({
        id: 'post_del',
        moderationState: 'published',
        deletedAt: new Date('2026-02-01'),
      }),
    ])

    const result = await getPublicChangelogById('cl_1' as ChangelogId)
    expect(result.linkedPosts.map((p) => p.id)).toEqual(['post_live'])
  })
})

describe('listPublicChangelogs — moderation state filter', () => {
  it('returns only published linked posts across all entries', async () => {
    const { listPublicChangelogs } = await import('../changelog.public')
    mockEntryFindMany.mockResolvedValueOnce([
      {
        id: 'cl_1' as ChangelogId,
        title: 'Release 1',
        content: '',
        contentJson: null,
        publishedAt: new Date('2026-01-02'),
      },
      {
        id: 'cl_2' as ChangelogId,
        title: 'Release 2',
        content: '',
        contentJson: null,
        publishedAt: new Date('2026-01-01'),
      },
    ])
    mockLinkedPostsFindMany.mockResolvedValueOnce([
      {
        ...linkedPost({ id: 'p_pub_1', moderationState: 'published' }),
        changelogEntryId: 'cl_1' as ChangelogId,
      },
      {
        ...linkedPost({ id: 'p_pen_1', moderationState: 'pending' }),
        changelogEntryId: 'cl_1' as ChangelogId,
      },
      {
        ...linkedPost({ id: 'p_pub_2', moderationState: 'published' }),
        changelogEntryId: 'cl_2' as ChangelogId,
      },
      {
        ...linkedPost({ id: 'p_spam_2', moderationState: 'spam' }),
        changelogEntryId: 'cl_2' as ChangelogId,
      },
    ])

    const result = await listPublicChangelogs({})
    const entry1 = result.items.find((e) => e.id === ('cl_1' as ChangelogId))!
    const entry2 = result.items.find((e) => e.id === ('cl_2' as ChangelogId))!
    expect(entry1.linkedPosts.map((p) => p.id)).toEqual(['p_pub_1'])
    expect(entry2.linkedPosts.map((p) => p.id)).toEqual(['p_pub_2'])
  })
})

describe('public changelog — board audience filter', () => {
  // Regression: a team-only post linked into a published changelog entry
  // would leak its title + board slug to anonymous viewers because the
  // filter only checked moderationState/deletedAt, not the linked post's
  // board audience. Same shape as the moderation leak above, on the
  // audience axis.

  it('getPublicChangelogById: hides linked posts whose board audience is not public', async () => {
    const { getPublicChangelogById } = await import('../changelog.public')
    mockEntryFindFirst.mockResolvedValueOnce({
      id: 'cl_1' as ChangelogId,
      title: 'Release Notes',
      content: '',
      contentJson: null,
      publishedAt: new Date('2026-01-01'),
    })
    mockLinkedPostsFindMany.mockResolvedValueOnce([
      linkedPost({ id: 'post_pub', moderationState: 'published' }),
      linkedPost({
        id: 'post_team',
        moderationState: 'published',
        audience: { kind: 'team' },
      }),
      linkedPost({
        id: 'post_auth',
        moderationState: 'published',
        audience: { kind: 'authenticated' },
      }),
      linkedPost({
        id: 'post_seg',
        moderationState: 'published',
        audience: { kind: 'segments', segmentIds: ['seg_a'] },
      }),
    ])

    const result = await getPublicChangelogById('cl_1' as ChangelogId)
    expect(result.linkedPosts.map((p) => p.id)).toEqual(['post_pub'])
  })

  it('listPublicChangelogs: hides non-public-audience linked posts across entries', async () => {
    const { listPublicChangelogs } = await import('../changelog.public')
    mockEntryFindMany.mockResolvedValueOnce([
      {
        id: 'cl_1' as ChangelogId,
        title: 'Release 1',
        content: '',
        contentJson: null,
        publishedAt: new Date('2026-01-02'),
      },
    ])
    mockLinkedPostsFindMany.mockResolvedValueOnce([
      {
        ...linkedPost({ id: 'p_pub', moderationState: 'published' }),
        changelogEntryId: 'cl_1' as ChangelogId,
      },
      {
        ...linkedPost({
          id: 'p_team',
          moderationState: 'published',
          audience: { kind: 'team' },
        }),
        changelogEntryId: 'cl_1' as ChangelogId,
      },
    ])

    const result = await listPublicChangelogs({})
    const entry = result.items.find((e) => e.id === ('cl_1' as ChangelogId))!
    expect(entry.linkedPosts.map((p) => p.id)).toEqual(['p_pub'])
  })
})
