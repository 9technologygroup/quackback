import { beforeEach, describe, expect, it, vi } from 'vitest'
import { POST_LIST_EXCERPT_LENGTH } from '../post.types'

const mockPosts = {
  id: Symbol('posts.id'),
  boardId: Symbol('posts.boardId'),
  principalId: Symbol('posts.principalId'),
  ownerPrincipalId: Symbol('posts.ownerPrincipalId'),
  statusId: Symbol('posts.statusId'),
  canonicalPostId: Symbol('posts.canonicalPostId'),
  deletedAt: Symbol('posts.deletedAt'),
  moderationState: Symbol('posts.moderationState'),
  voteCount: Symbol('posts.voteCount'),
  commentCount: Symbol('posts.commentCount'),
  createdAt: Symbol('posts.createdAt'),
  updatedAt: Symbol('posts.updatedAt'),
  searchVector: Symbol('posts.searchVector'),
}

const mockPostsFindMany = vi.fn().mockResolvedValue([])
const mockSubWhere = vi.fn().mockReturnValue(Symbol('subquery'))

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      posts: {
        findMany: (...args: unknown[]) => mockPostsFindMany(...args),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: mockSubWhere }),
      selectDistinct: vi.fn(),
    }),
    selectDistinct: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: mockSubWhere }),
    }),
  },
  posts: mockPosts,
  postStatuses: { id: Symbol('postStatuses.id'), slug: Symbol('postStatuses.slug') },
  postTags: { postId: Symbol('postTags.postId'), tagId: Symbol('postTags.tagId') },
  userSegments: {
    principalId: Symbol('userSegments.principalId'),
    segmentId: Symbol('userSegments.segmentId'),
  },
  ne: vi.fn((col, val) => ({ _tag: 'ne', col, val })),
  eq: vi.fn((col, val) => ({ _tag: 'eq', col, val })),
  and: vi.fn((...args) => ({ _tag: 'and', args })),
  or: vi.fn((...args) => ({ _tag: 'or', args })),
  isNull: vi.fn((col) => ({ _tag: 'isNull', col })),
  isNotNull: vi.fn((col) => ({ _tag: 'isNotNull', col })),
  inArray: vi.fn((col, arr) => ({ _tag: 'inArray', col, arr })),
  desc: vi.fn((col) => ({ _tag: 'desc', col })),
  asc: vi.fn((col) => ({ _tag: 'asc', col })),
  sql: vi.fn(() => ({})),
}))

/** A body longer than the excerpt cap, to prove truncation actually fires. */
const LONG_BODY = 'x'.repeat(POST_LIST_EXCERPT_LENGTH * 3)

function row(content: string) {
  return {
    id: 'post_1',
    boardId: 'board_1',
    title: 'A post',
    content,
    contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
    principalId: null,
    statusId: null,
    ownerPrincipalId: null,
    voteCount: 0,
    commentCount: 0,
    pinnedCommentId: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    deletedAt: null,
    isCommentsLocked: false,
    moderationState: 'approved',
    canonicalPostId: null,
    mergedAt: null,
    summaryJson: null,
    summaryUpdatedAt: null,
    board: { id: 'board_1', name: 'Feature Requests', slug: 'features' },
    tags: [],
    author: { displayName: 'Ada' },
  }
}

describe('listInboxPosts — excerpt mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPostsFindMany.mockResolvedValue([row(LONG_BODY)])
  })

  it('returns the full body and selects contentJson by default', async () => {
    const { listInboxPosts } = await import('../post.inbox')

    const result = await listInboxPosts({})

    expect(result.items[0].content).toBe(LONG_BODY)
    expect(mockPostsFindMany.mock.calls[0][0].columns.contentJson).toBe(true)
  })

  it('truncates the body to the excerpt cap when excerpt is set', async () => {
    const { listInboxPosts } = await import('../post.inbox')

    const result = await listInboxPosts({ excerpt: true })

    expect(result.items[0].content).not.toBe(LONG_BODY)
    expect(result.items[0].content.length).toBe(POST_LIST_EXCERPT_LENGTH)
    expect(result.items[0].content.startsWith('xxx')).toBe(true)
  })

  it('does not select contentJson in excerpt mode — it is the heavier column', async () => {
    const { listInboxPosts } = await import('../post.inbox')

    await listInboxPosts({ excerpt: true })

    expect(mockPostsFindMany.mock.calls[0][0].columns.contentJson).toBe(false)
  })

  it('leaves a body shorter than the cap untouched', async () => {
    mockPostsFindMany.mockResolvedValue([row('short body')])
    const { listInboxPosts } = await import('../post.inbox')

    const result = await listInboxPosts({ excerpt: true })

    expect(result.items[0].content).toBe('short body')
  })
})
