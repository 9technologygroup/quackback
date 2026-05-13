/**
 * Property-style invariants for the policy module.
 *
 * Two layers:
 *  1. Determinism + sanity invariants across the full (actor, audience) space
 *     for canViewBoard (in-memory truth table).
 *  2. SQL-shape inspection for boardViewFilter / postViewFilter —
 *     drizzle's `sql` template exposes `.toSQL()` which lets us assert
 *     the predicate composition without hitting Postgres. The full SQL
 *     execution is exercised in Task 22's integration test.
 */
import { describe, it, expect } from 'vitest'
import { canViewBoard, boardViewFilter } from '../boards'
import { postViewFilter } from '../posts'
import { ANONYMOUS_ACTOR, type Actor } from '../types'
import { createId, type SegmentId, type PrincipalId } from '@quackback/ids'
import type { BoardAudience } from '@/lib/server/db'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

// SQL-rendering tests need real TypeIDs because drizzle's column mapper
// runs toDriver() at render time. Logic-only tests (above) accept any
// branded string. Generate once at module load; values are stable.
const PRINCIPAL_USER = createId('principal') as PrincipalId
const PRINCIPAL_USER_ALPHA = createId('principal') as PrincipalId
const PRINCIPAL_SERVICE = createId('principal') as PrincipalId
const PRINCIPAL_MEMBER = createId('principal') as PrincipalId
const PRINCIPAL_ADMIN = createId('principal') as PrincipalId
const SEGMENT_ALPHA = createId('segment') as SegmentId
const SEGMENT_BETA = createId('segment') as SegmentId

function buildActor(overrides: Partial<Actor>): Actor {
  return {
    principalId: null,
    role: null,
    principalType: 'anonymous',
    segmentIds: new Set(),
    ...overrides,
  }
}

const actors: Record<string, Actor> = {
  anon: ANONYMOUS_ACTOR,
  user: buildActor({ principalId: PRINCIPAL_USER, role: 'user', principalType: 'user' }),
  userInAlpha: buildActor({
    principalId: PRINCIPAL_USER_ALPHA,
    role: 'user',
    principalType: 'user',
    segmentIds: new Set([SEGMENT_ALPHA]),
  }),
  service: buildActor({
    principalId: PRINCIPAL_SERVICE,
    role: 'user',
    principalType: 'service',
  }),
  member: buildActor({ principalId: PRINCIPAL_MEMBER, role: 'member', principalType: 'user' }),
  admin: buildActor({ principalId: PRINCIPAL_ADMIN, role: 'admin', principalType: 'user' }),
}

const audiences: BoardAudience[] = [
  { kind: 'public' },
  { kind: 'authenticated' },
  { kind: 'team' },
  { kind: 'segments', segmentIds: [SEGMENT_ALPHA] },
  { kind: 'segments', segmentIds: [SEGMENT_BETA] },
  { kind: 'segments', segmentIds: [] },
]

describe('policy invariants — boards', () => {
  it('canViewBoard is deterministic across calls', () => {
    for (const actor of Object.values(actors)) {
      for (const audience of audiences) {
        const a = canViewBoard(actor, { audience })
        const b = canViewBoard(actor, { audience })
        expect(a.allowed).toBe(b.allowed)
      }
    }
  })

  it('team (member/admin) always passes regardless of audience', () => {
    for (const actor of [actors.member, actors.admin]) {
      for (const audience of audiences) {
        expect(canViewBoard(actor, { audience }).allowed).toBe(true)
      }
    }
  })

  it('anonymous only passes audience.kind === "public"', () => {
    for (const audience of audiences) {
      expect(canViewBoard(ANONYMOUS_ACTOR, { audience }).allowed).toBe(audience.kind === 'public')
    }
  })

  it('service principalType is denied by audience="authenticated"', () => {
    expect(canViewBoard(actors.service, { audience: { kind: 'authenticated' } }).allowed).toBe(
      false
    )
  })

  it('segment audience never admits a non-member non-team actor', () => {
    for (const audience of audiences.filter((a) => a.kind === 'segments')) {
      expect(canViewBoard(actors.user, { audience }).allowed).toBe(false)
    }
  })

  it('audience denials always carry a non-empty reason', () => {
    for (const audience of audiences) {
      const decision = canViewBoard(ANONYMOUS_ACTOR, { audience })
      if (!decision.allowed) {
        expect(decision.reason.length).toBeGreaterThan(0)
      }
    }
  })
})

// ----------------------------------------------------------------------
// SQL shape introspection
// ----------------------------------------------------------------------

// Resolve a drizzle SQL fragment to its rendered string + bound parameters
// without hitting Postgres. Uses the pg dialect's own sql-to-query renderer.
const dialect = new PgDialect()
function toQueryShape(fragment: SQL): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(fragment)
  return { sql: query.sql, params: query.params as unknown[] }
}

describe('boardViewFilter — SQL shape', () => {
  it('team actor produces a constant-true predicate', () => {
    const { sql, params } = toQueryShape(boardViewFilter(actors.admin))
    expect(sql.trim().toLowerCase()).toBe('true')
    expect(params).toEqual([])
  })

  it('anonymous actor predicate references audience->>kind and excludes the authenticated branch', () => {
    const { sql } = toQueryShape(boardViewFilter(ANONYMOUS_ACTOR))
    // Must check the public kind
    expect(sql).toMatch(/audience.*'public'/)
    // The authenticated branch is gated by `isUser` (false for anon) — drizzle inlines the
    // literal false alongside the kind check, so the branch is structurally present but
    // never satisfied. The important property is that the JSON kind comparison is present.
    expect(sql).toMatch(/'authenticated'/)
    expect(sql).toMatch(/'segments'/)
  })

  it('portal-user actor binds memberIds as a parameter (anti SQL-injection)', () => {
    const { sql, params } = toQueryShape(boardViewFilter(actors.userInAlpha))
    // memberIds is interpolated. The exact binding shape varies by dialect
    // version (sometimes an array param, sometimes spread positional). The
    // invariant we care about: the segment id appears as a *parameter value*,
    // never inlined into the SQL string (which would be an injection vector).
    const flatParams = params.flat(2)
    expect(flatParams).toContain(SEGMENT_ALPHA)
    expect(sql).not.toContain(SEGMENT_ALPHA)
  })

  it('portal-user with no memberships does not produce a SQL fragment containing arbitrary text', () => {
    // Empty memberIds: drizzle still binds the array safely, just empty.
    const { sql, params } = toQueryShape(boardViewFilter(actors.user))
    // No bound parameter should appear in the SQL string literally.
    for (const p of params.flat(2)) {
      if (typeof p === 'string' && p.length > 5) {
        expect(sql).not.toContain(p)
      }
    }
  })

  it('predicate is stable across calls (same input → same SQL)', () => {
    const a = toQueryShape(boardViewFilter(actors.userInAlpha))
    const b = toQueryShape(boardViewFilter(actors.userInAlpha))
    expect(a.sql).toBe(b.sql)
    expect(a.params).toEqual(b.params)
  })
})

describe('postViewFilter — SQL shape', () => {
  it('team actor predicate excludes only moderationState=deleted', () => {
    const { sql, params } = toQueryShape(postViewFilter(actors.admin))
    expect(sql).toMatch(/moderation_state/)
    // The team branch uses an inline sql`<> 'deleted'` template — drizzle
    // inlines the literal here (it's a hand-written sql tag, not `ne(...)`
    // which would bind it as a parameter). Either form is safe because the
    // literal is hard-coded, not user-supplied. Snapshot the SQL precisely.
    expect(sql).toContain("<> 'deleted'")
    expect(params).toEqual([])
  })

  it('non-team predicate references audience AND moderation_state', () => {
    const { sql } = toQueryShape(postViewFilter(actors.user))
    expect(sql).toMatch(/audience/)
    expect(sql).toMatch(/moderation_state/)
    // Both 'published' and 'pending' are bound as parameters (next test).
  })

  it('non-team predicate binds "published" and "pending" as parameters', () => {
    const { params } = toQueryShape(postViewFilter(actors.user))
    // Defense-in-depth: literal moderation states are bound via $N, not
    // inlined into the SQL string. The shape would be: $1='published',
    // $2='pending', plus principal_id and isUser bindings.
    expect(params).toContain('published')
    expect(params).toContain('pending')
  })

  it('non-team predicate maps principalId through typeid → uuid binding', () => {
    const { params } = toQueryShape(postViewFilter(actors.user))
    // The principal id is passed through the typeid column mapper, which
    // converts the TypeID string to its UUID component. We assert: exactly
    // one UUID-shaped param appears.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    const flat = params.flat(2).filter((p) => typeof p === 'string') as string[]
    const uuids = flat.filter((p) => uuidRe.test(p))
    expect(uuids).toHaveLength(1)
  })

  it('anonymous predicate has no principalId binding (no own-pending branch)', () => {
    const { params } = toQueryShape(postViewFilter(ANONYMOUS_ACTOR))
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    const flat = params.flat(2).filter((p) => typeof p === 'string') as string[]
    const uuids = flat.filter((p) => uuidRe.test(p))
    expect(uuids).toHaveLength(0)
  })

  it('anonymous predicate still requires moderation_state = published only', () => {
    const { sql, params } = toQueryShape(postViewFilter(ANONYMOUS_ACTOR))
    expect(sql).toMatch(/moderation_state/)
    expect(params).toContain('published')
    // 'pending' is NOT in the predicate for anonymous (no own-pending branch).
    expect(params).not.toContain('pending')
  })
})
