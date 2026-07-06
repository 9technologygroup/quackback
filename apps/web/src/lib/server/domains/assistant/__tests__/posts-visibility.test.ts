/**
 * Execution-level test for `postsVisibilityConditions`: for a matrix of post
 * states (published on a public board, pending, merged, soft-deleted,
 * published on a non-public board), the SQL predicate admits exactly the rows
 * the ceiling should see. This is the safety-critical property the posts
 * grounding source depends on — a post on a non-public board (or a
 * draft/merged/deleted one) must never reach a public-ceiling caller.
 *
 * Connects via DATABASE_URL (falling back to the dev DB), skipping gracefully
 * if neither is reachable — matches board-view-filter-parity.test.ts /
 * post-view-filter-parity.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql, eq, and } from 'drizzle-orm'
import { boards, posts, principal, type BoardAccess, type Database } from '@/lib/server/db'
// eslint-disable-next-line no-restricted-imports -- legitimate second createDb caller (see board-view-filter-parity.test.ts)
import { createDb } from '@quackback/db/client'
import { postsVisibilityConditions } from '../posts-retrieval'
import type { ContentAudience } from '../audience'
import { createId, type PrincipalId, type BoardId, type PostId } from '@quackback/ids'

const P_AUTHOR = createId('principal') as PrincipalId

function mkAccess(view: BoardAccess['view']): BoardAccess {
  return {
    view,
    vote: view,
    comment: view,
    submit: view,
    segments: { view: [], vote: [], comment: [], submit: [] },
    moderation: { anonPosts: 'inherit', signedPosts: 'inherit', comments: 'inherit' },
  }
}

const CANDIDATE_URLS = [
  process.env.DATABASE_URL,
  'postgresql://postgres:password@localhost:5432/quackback',
].filter((u): u is string => !!u)

async function pickWorkingDb(): Promise<{ db: Database; close: () => Promise<void> } | null> {
  for (const url of CANDIDATE_URLS) {
    try {
      const db = createDb(url, { max: 2, prepare: false })
      await db.execute(sql`select 1`)
      await db.execute(sql`select id from ${posts} limit 0`)
      return {
        db,
        close: async () => {
          const raw = (db as unknown as { $client?: { end?: () => Promise<void> } }).$client
          await raw?.end?.()
        },
      }
    } catch {
      // try next candidate
    }
  }
  return null
}

let activeDb: Database | null = null
let closeDb: (() => Promise<void>) | null = null
const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const resolved = await pickWorkingDb()
const dbAvailable = resolved !== null
if (resolved) {
  activeDb = resolved.db
  closeDb = resolved.close
}

interface PostCase {
  name: string
  boardName: 'public' | 'restricted'
  moderationState: 'published' | 'pending'
  merged?: boolean
  deleted?: boolean
  /** Whether this row should be visible for the 'public' ceiling. */
  publicVisible: boolean
  /** Whether this row should be visible for the 'team' ceiling. */
  teamVisible: boolean
}

const cases: PostCase[] = [
  {
    name: 'published_public_board',
    boardName: 'public',
    moderationState: 'published',
    publicVisible: true,
    teamVisible: true,
  },
  {
    name: 'pending_public_board',
    boardName: 'public',
    moderationState: 'pending',
    publicVisible: false,
    teamVisible: false,
  },
  {
    name: 'merged_public_board',
    boardName: 'public',
    moderationState: 'published',
    merged: true,
    publicVisible: false,
    teamVisible: false,
  },
  {
    name: 'deleted_public_board',
    boardName: 'public',
    moderationState: 'published',
    deleted: true,
    publicVisible: false,
    teamVisible: false,
  },
  {
    name: 'published_restricted_board',
    boardName: 'restricted',
    moderationState: 'published',
    publicVisible: false,
    teamVisible: true,
  },
]

const boardIds = new Map<string, BoardId>()
const postIds = new Map<string, PostId>()

describe.skipIf(!dbAvailable)('postsVisibilityConditions (execution-level)', () => {
  beforeAll(async () => {
    if (!activeDb) return
    await activeDb.delete(posts).where(sql`${posts.title} ~ '^pv-[0-9]+-'`)
    await activeDb.delete(boards).where(sql`${boards.slug} ~ '^pv-[0-9]+-'`)
    await activeDb
      .insert(principal)
      .values({ id: P_AUTHOR, createdAt: new Date() })
      .onConflictDoNothing()

    for (const boardName of ['public', 'restricted'] as const) {
      const boardId = createId('board') as BoardId
      await activeDb.insert(boards).values({
        id: boardId,
        slug: `pv-${runSuffix}-${boardName}`,
        name: `pv:${boardName}`,
        access: mkAccess(boardName === 'public' ? 'anonymous' : 'team'),
      })
      boardIds.set(boardName, boardId)
    }

    for (const c of cases) {
      const postId = createId('post') as PostId
      await activeDb.insert(posts).values({
        id: postId,
        boardId: boardIds.get(c.boardName)!,
        principalId: P_AUTHOR,
        title: `pv-${runSuffix}-${c.name}`,
        content: 'visibility fixture',
        moderationState: c.moderationState,
        canonicalPostId: c.merged ? (createId('post') as PostId) : null,
        deletedAt: c.deleted ? new Date() : null,
      })
      postIds.set(c.name, postId)
    }
  })

  afterAll(async () => {
    if (!activeDb) return
    try {
      await activeDb.delete(posts).where(sql`${posts.title} LIKE ${`pv-${runSuffix}-%`}`)
      await activeDb.delete(boards).where(sql`${boards.slug} LIKE ${`pv-${runSuffix}-%`}`)
      await activeDb.delete(principal).where(eq(principal.id, P_AUTHOR))
    } finally {
      await closeDb?.()
    }
  })

  const ceilings: Array<{ ceiling: ContentAudience; key: 'publicVisible' | 'teamVisible' }> = [
    { ceiling: 'public', key: 'publicVisible' },
    { ceiling: 'team', key: 'teamVisible' },
  ]

  for (const c of cases) {
    for (const { ceiling, key } of ceilings) {
      it(`case=${c.name} ceiling=${ceiling} -> visible=${c[key]}`, async () => {
        if (!activeDb) return
        const postId = postIds.get(c.name)
        expect(postId, `seed missing for ${c.name}`).toBeDefined()
        if (!postId) return

        const matched = await activeDb
          .select({ id: posts.id })
          .from(posts)
          .innerJoin(boards, eq(posts.boardId, boards.id))
          .where(and(eq(posts.id, postId), ...postsVisibilityConditions(ceiling)))

        expect(matched.length === 1).toBe(c[key])
      })
    }
  }
})
