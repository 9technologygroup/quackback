/**
 * Tests for updateBoardAccessFn.
 *
 * Codex review (P1) flagged: this mutation governs *who can see a board* —
 * it is policy-changing work and must be admin-only. The previous draft
 * used isTeamMember which would let role='member' change board visibility.
 *
 * This test file pins the isAdmin gate, the audit branches (one event per
 * field changed, no event when nothing supplied), and the not-found path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Handler = (args: { data: Record<string, unknown> }) => Promise<unknown>
const hoisted = vi.hoisted(() => ({ handlers: [] as Handler[] }))

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const chain = {
      inputValidator() {
        return chain
      },
      handler(fn: Handler) {
        hoisted.handlers.push(fn)
        return chain
      },
    }
    return chain
  },
}))

const mockRequireAuth = vi.fn()
vi.mock('./auth-helpers', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}))

vi.mock('@/lib/server/functions/auth-helpers', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}))

vi.mock('./workspace', () => ({ getSettings: vi.fn() }))

// Mock the boards-service surface that the existing boards.ts imports.
// `audienceToAccess` is a pure derivation — stub it with the same mapping the
// real implementation uses, so the dual-write assertion can check the shape.
type StubAccessTier = 'anonymous' | 'authenticated' | 'team' | 'segments'
function stubAudienceToAccess(audience: { kind: string; segmentIds?: string[] }): {
  view: StubAccessTier
  comment: StubAccessTier
  submit: StubAccessTier
  segmentIds: string[]
  approval: { posts: boolean; comments: boolean }
} {
  const tier: StubAccessTier =
    audience.kind === 'public'
      ? 'anonymous'
      : audience.kind === 'authenticated'
        ? 'authenticated'
        : audience.kind === 'team'
          ? 'team'
          : audience.kind === 'segments'
            ? 'segments'
            : 'anonymous'
  return {
    view: tier,
    comment: tier,
    submit: tier,
    segmentIds: audience.kind === 'segments' ? (audience.segmentIds ?? []) : [],
    approval: { posts: false, comments: false },
  }
}

vi.mock('@/lib/server/domains/boards/board.service', () => ({
  listBoards: vi.fn(),
  getBoardById: vi.fn(),
  createBoard: vi.fn(),
  updateBoard: vi.fn(),
  deleteBoard: vi.fn(),
  audienceToAccess: vi.fn(stubAudienceToAccess),
}))

vi.mock('@/lib/server/domains/settings/settings.helpers', () => ({
  invalidateSettingsCache: vi.fn(),
}))

// DB mock — only the operations updateBoardAccessFn uses.
type BoardRow = {
  id: string
  audience: { kind: string; segmentIds?: string[] }
  access?: Record<string, unknown>
}
const state: {
  boards: BoardRow[]
  updates: Array<Partial<BoardRow>>
  auditEvents: Array<Record<string, unknown>>
} = {
  boards: [],
  updates: [],
  auditEvents: [],
}

interface BoardsColumn {
  __col: keyof BoardRow
}
type BoardCondition = { kind: 'eq'; col: keyof BoardRow; val: string }

function matchBoard(b: BoardRow, c: BoardCondition): boolean {
  return b[c.col] === c.val
}

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      boards: {
        findFirst: vi.fn(async (args: { where: BoardCondition }) =>
          state.boards.find((b) => matchBoard(b, args.where))
        ),
      },
    },
    update: vi.fn(() => ({
      set: vi.fn((patch: Partial<BoardRow>) => ({
        where: vi.fn(async (cond: BoardCondition) => {
          state.updates.push(patch)
          state.boards = state.boards.map((b) => (matchBoard(b, cond) ? { ...b, ...patch } : b))
        }),
      })),
    })),
    settings: {}, // referenced by boards.ts even if unused here
    eq: vi.fn(),
  },
  boards: {
    id: { __col: 'id' } satisfies BoardsColumn,
  },
  settings: {},
  eq: vi.fn(
    (col: BoardsColumn, val: string): BoardCondition => ({
      kind: 'eq',
      col: col.__col,
      val,
    })
  ),
  // T15 introduced boardAccessSchema at module-evaluation time; its tier
  // enum reads these constants from the db barrel. Keep in sync with the
  // real export — order matters for z.enum's error messages but not for
  // validity since we only assert tier membership.
  ACCESS_TIERS: ['anonymous', 'authenticated', 'segments', 'team'] as const,
  ACCESS_TIER_RANK: { anonymous: 0, authenticated: 1, segments: 2, team: 3 } as const,
}))

vi.mock('@/lib/server/audit/log', () => ({
  recordAuditEvent: vi.fn(async (e: Record<string, unknown>) => {
    state.auditEvents.push(e)
  }),
  actorFromAuth: vi.fn(
    (auth: { user: { id: string; email: string }; principal: { role: string } }) => ({
      userId: auth.user.id,
      email: auth.user.email,
      role: auth.principal.role,
    })
  ),
}))

import { ForbiddenError, NotFoundError } from '@/lib/shared/errors'

// Import after mocks; this captures handlers into hoisted.handlers in
// declaration order. Boards.ts has many existing fns ahead of
// updateBoardAccessFn — we resolve it via name, not index.
import * as boardsModule from '../boards'

function getUpdateBoardAccessFn(): Handler {
  // updateBoardAccessFn was appended last; pick the last handler captured
  // that matches the expected behaviour (it accepts {boardId, audience?}).
  // We bind via the module export's metadata as a sanity check, then
  // return the matching captured handler.
  expect(boardsModule).toHaveProperty('updateBoardAccessFn')
  return hoisted.handlers[hoisted.handlers.length - 1]
}

const AUTH_ADMIN = {
  user: { id: 'u_admin', email: 'admin@x', name: 'Admin', image: null },
  principal: { id: 'p_admin', role: 'admin' as const, type: 'user' },
  settings: { id: 'ws_1', slug: 'x', name: 'X', logoKey: null },
}
const AUTH_MEMBER = {
  ...AUTH_ADMIN,
  principal: { ...AUTH_ADMIN.principal, role: 'member' as const },
}
const AUTH_USER = { ...AUTH_ADMIN, principal: { ...AUTH_ADMIN.principal, role: 'user' as const } }

const BOARD_DEFAULT: BoardRow = {
  id: 'board_1',
  audience: { kind: 'public' },
}

beforeEach(() => {
  state.boards = [{ ...BOARD_DEFAULT }]
  state.updates = []
  state.auditEvents = []
  mockRequireAuth.mockReset()
})

describe('updateBoardAccessFn — auth propagation', () => {
  it('propagates requireAuth rejection (no swallowing 401 into 500)', async () => {
    const authError = new Error('UNAUTHORIZED')
    mockRequireAuth.mockRejectedValue(authError)
    await expect(
      getUpdateBoardAccessFn()({
        data: { boardId: 'board_1', audience: { kind: 'public' } },
      })
    ).rejects.toBe(authError)
    // Nothing happens at the data layer.
    expect(state.updates).toEqual([])
    expect(state.auditEvents).toEqual([])
  })
})

describe('updateBoardAccessFn — isAdmin gate (codex P1)', () => {
  it('rejects role=user with ForbiddenError', async () => {
    mockRequireAuth.mockResolvedValue(AUTH_USER)
    await expect(
      getUpdateBoardAccessFn()({
        data: { boardId: 'board_1', audience: { kind: 'public' } },
      })
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('rejects role=member with ForbiddenError (members can moderate but not change policy)', async () => {
    // This is the specific codex finding: an earlier draft used isTeamMember
    // which would let members through. Members must NOT be able to flip a
    // board to public or change moderation policy.
    mockRequireAuth.mockResolvedValue(AUTH_MEMBER)
    await expect(
      getUpdateBoardAccessFn()({
        data: { boardId: 'board_1', audience: { kind: 'public' } },
      })
    ).rejects.toBeInstanceOf(ForbiddenError)
    // Neither updates nor audit fired.
    expect(state.updates).toEqual([])
    expect(state.auditEvents).toEqual([])
  })

  it('admin call proceeds', async () => {
    mockRequireAuth.mockResolvedValue(AUTH_ADMIN)
    await getUpdateBoardAccessFn()({
      data: { boardId: 'board_1', audience: { kind: 'team' } },
    })
    expect(state.updates).toHaveLength(1)
  })
})

describe('updateBoardAccessFn — not-found', () => {
  it('returns NotFoundError when boardId does not match any row', async () => {
    mockRequireAuth.mockResolvedValue(AUTH_ADMIN)
    await expect(
      getUpdateBoardAccessFn()({
        data: { boardId: 'missing', audience: { kind: 'public' } },
      })
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('updateBoardAccessFn — audit branches', () => {
  beforeEach(() => mockRequireAuth.mockResolvedValue(AUTH_ADMIN))

  it('audience-only update fires one event (board.audience.changed)', async () => {
    await getUpdateBoardAccessFn()({
      data: { boardId: 'board_1', audience: { kind: 'team' } },
    })
    expect(state.auditEvents).toHaveLength(1)
    expect(state.auditEvents[0].event).toBe('board.audience.changed')
    expect((state.auditEvents[0].before as { audience: unknown }).audience).toEqual({
      kind: 'public',
    })
    expect((state.auditEvents[0].after as { audience: unknown }).audience).toEqual({
      kind: 'team',
    })
  })

  it('no-field update is a no-op — no audit, no db update', async () => {
    await getUpdateBoardAccessFn()({ data: { boardId: 'board_1' } })
    expect(state.updates).toEqual([])
    expect(state.auditEvents).toEqual([])
  })
})

describe('updateBoardAccessFn — segments audience persists segmentIds[]', () => {
  beforeEach(() => mockRequireAuth.mockResolvedValue(AUTH_ADMIN))

  it('stores the segmentIds array on the audience', async () => {
    await getUpdateBoardAccessFn()({
      data: {
        boardId: 'board_1',
        audience: { kind: 'segments', segmentIds: ['segment_a', 'segment_b'] },
      },
    })
    expect(state.boards[0].audience).toEqual({
      kind: 'segments',
      segmentIds: ['segment_a', 'segment_b'],
    })
  })
})

describe('updateBoardAccessFn — dual-write audience + derived access', () => {
  // Until T16 rewrites this handler to accept an access payload directly, the
  // legacy `audience` column and the new `access` column must move together —
  // otherwise canViewBoard (post-Phase 2) reads stale tier data after every
  // audience change.
  beforeEach(() => {
    mockRequireAuth.mockResolvedValue(AUTH_ADMIN)
    state.boards = [{ id: 'board_1', audience: { kind: 'public' }, access: { view: 'anonymous' } }]
  })

  it('writes both audience and derived access to the same update', async () => {
    await getUpdateBoardAccessFn()({
      data: { boardId: 'board_1', audience: { kind: 'team' } },
    })
    expect(state.updates).toHaveLength(1)
    const patch = state.updates[0] as { audience?: unknown; access?: unknown }
    expect(patch.audience).toEqual({ kind: 'team' })
    expect(patch.access).toMatchObject({
      view: 'team',
      comment: 'team',
      submit: 'team',
    })
  })

  it('audit before/after capture both audience and access', async () => {
    await getUpdateBoardAccessFn()({
      data: { boardId: 'board_1', audience: { kind: 'team' } },
    })
    expect(state.auditEvents).toHaveLength(1)
    const before = state.auditEvents[0].before as { audience: unknown; access: unknown }
    const after = state.auditEvents[0].after as { audience: unknown; access: unknown }
    expect(before.audience).toEqual({ kind: 'public' })
    expect(before.access).toBeDefined()
    expect(after.audience).toEqual({ kind: 'team' })
    expect(after.access).toMatchObject({ view: 'team', comment: 'team', submit: 'team' })
  })
})
