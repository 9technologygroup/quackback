/**
 * Tests for the T16 expansion of updateBoardAccessFn.
 *
 * After T16 the handler accepts BOTH a legacy `audience` payload AND a direct
 * `access` payload. When `access` is provided it wins and audience is left
 * untouched. The boardAccessSchema's tier-rank invariants must be enforced by
 * input validation (so callers can't slip an inconsistent matrix past the
 * server).
 *
 * The base auth + dual-write contract from PR1 is covered in board-access.test.ts;
 * this file only pins the new behaviours T16 adds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Handler = (args: { data: Record<string, unknown> }) => Promise<unknown>
const hoisted = vi.hoisted(() => ({ handlers: [] as Handler[] }))

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const chain = {
      inputValidator(parse: (data: unknown) => unknown) {
        // Capture the validator so we can drive it at the handler call site —
        // T16 promotes a Zod schema to gate inputs, and we need real
        // validation errors to bubble out (not silently bypass).
        const inner = {
          handler(fn: Handler) {
            const wrapped: Handler = async ({ data }) => {
              const validated = parse(data)
              return fn({ data: validated as Record<string, unknown> })
            }
            hoisted.handlers.push(wrapped)
            return inner
          },
        }
        return inner
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

// Mirror the real audienceToAccess derivation so dual-write assertions work.
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
    settings: {},
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
  // Real constants from db re-export — keep in sync with the schema-level enum.
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

// Import after mocks; the handler is captured by the createServerFn shim above.
import * as boardsModule from '../boards'

function getUpdateBoardAccessFn(): Handler {
  expect(boardsModule).toHaveProperty('updateBoardAccessFn')
  return hoisted.handlers[hoisted.handlers.length - 1]
}

const AUTH_ADMIN = {
  user: { id: 'u_admin', email: 'admin@x', name: 'Admin', image: null },
  principal: { id: 'p_admin', role: 'admin' as const, type: 'user' },
  settings: { id: 'ws_1', slug: 'x', name: 'X', logoKey: null },
}

const BOARD_DEFAULT: BoardRow = {
  id: 'board_1',
  audience: { kind: 'public' },
  access: {
    view: 'anonymous',
    comment: 'anonymous',
    submit: 'anonymous',
    segmentIds: [],
    approval: { posts: false, comments: false },
  },
}

beforeEach(() => {
  state.boards = [{ ...BOARD_DEFAULT }]
  state.updates = []
  state.auditEvents = []
  mockRequireAuth.mockReset()
  mockRequireAuth.mockResolvedValue(AUTH_ADMIN)
})

describe('updateBoardAccessFn — accepts access payload directly (T16)', () => {
  it('accepts an access object shaped like BoardAccess', async () => {
    await getUpdateBoardAccessFn()({
      data: {
        boardId: 'board_1',
        access: {
          view: 'anonymous',
          comment: 'anonymous',
          submit: 'anonymous',
          segmentIds: [],
          approval: { posts: false, comments: false },
        },
      },
    })
    expect(state.updates).toHaveLength(1)
  })

  it('rejects an access with comment tier below view tier', async () => {
    await expect(
      getUpdateBoardAccessFn()({
        data: {
          boardId: 'board_1',
          access: {
            view: 'authenticated',
            comment: 'anonymous',
            submit: 'authenticated',
            segmentIds: [],
            approval: { posts: false, comments: false },
          },
        },
      })
    ).rejects.toThrow()
  })

  it('rejects an access with segments tier and empty segmentIds', async () => {
    await expect(
      getUpdateBoardAccessFn()({
        data: {
          boardId: 'board_1',
          access: {
            view: 'segments',
            comment: 'segments',
            submit: 'segments',
            segmentIds: [],
            approval: { posts: false, comments: false },
          },
        },
      })
    ).rejects.toThrow()
  })

  it('still accepts the legacy audience-only payload (no regression)', async () => {
    await getUpdateBoardAccessFn()({
      data: {
        boardId: 'board_1',
        audience: { kind: 'team' },
      },
    })
    expect(state.updates).toHaveLength(1)
    const patch = state.updates[0] as { audience?: unknown; access?: unknown }
    expect(patch.audience).toEqual({ kind: 'team' })
    expect(patch.access).toBeDefined()
  })
})

describe('updateBoardAccessFn — access-only path (T16)', () => {
  it('when only access is provided, writes access and leaves audience alone', async () => {
    const access = {
      view: 'authenticated' as const,
      comment: 'team' as const,
      submit: 'team' as const,
      segmentIds: [],
      approval: { posts: true, comments: false },
    }
    await getUpdateBoardAccessFn()({ data: { boardId: 'board_1', access } })

    expect(state.updates).toHaveLength(1)
    const patch = state.updates[0] as { audience?: unknown; access?: unknown }
    expect(patch.access).toEqual(access)
    // The caller didn't ask to change audience; we must NOT clobber it.
    expect(patch.audience).toBeUndefined()
    // And the row's audience is still the seed value.
    expect(state.boards[0].audience).toEqual({ kind: 'public' })
  })

  it('fires board.access.changed audit with before/after access', async () => {
    const access = {
      view: 'authenticated' as const,
      comment: 'team' as const,
      submit: 'team' as const,
      segmentIds: [],
      approval: { posts: true, comments: false },
    }
    await getUpdateBoardAccessFn()({ data: { boardId: 'board_1', access } })

    expect(state.auditEvents).toHaveLength(1)
    expect(state.auditEvents[0].event).toBe('board.access.changed')
    const before = state.auditEvents[0].before as { access: unknown }
    const after = state.auditEvents[0].after as { access: unknown }
    expect(before.access).toEqual(BOARD_DEFAULT.access)
    expect(after.access).toEqual(access)
  })

  it('when both audience and access are provided, access wins (no audience write)', async () => {
    const access = {
      view: 'team' as const,
      comment: 'team' as const,
      submit: 'team' as const,
      segmentIds: [],
      approval: { posts: false, comments: false },
    }
    await getUpdateBoardAccessFn()({
      data: {
        boardId: 'board_1',
        audience: { kind: 'authenticated' },
        access,
      },
    })

    expect(state.updates).toHaveLength(1)
    const patch = state.updates[0] as { audience?: unknown; access?: unknown }
    expect(patch.access).toEqual(access)
    expect(patch.audience).toBeUndefined()
    // Audit event reflects the access change, not the audience change.
    expect(state.auditEvents).toHaveLength(1)
    expect(state.auditEvents[0].event).toBe('board.access.changed')
  })
})
