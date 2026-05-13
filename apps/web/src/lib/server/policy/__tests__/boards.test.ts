/**
 * Exhaustive matrix for canViewBoard.
 *
 * Every audience kind × every meaningful actor shape. The goal is to make
 * any future regression in board-visibility logic detectable from a single
 * test failure with an unambiguous diagnostic message.
 *
 * Reads alongside `invariants.test.ts` which property-checks
 * determinism and the team-bypass invariant.
 */
import { describe, it, expect } from 'vitest'
import { canViewBoard } from '../boards'
import { ANONYMOUS_ACTOR, type Actor } from '../types'
import type { SegmentId, PrincipalId } from '@quackback/ids'
import type { BoardAudience } from '@/lib/server/db'

// ----------------------------------------------------------------------
// Actor fixtures — one per meaningful shape
// ----------------------------------------------------------------------

const adminActor: Actor = {
  principalId: 'principal_admin' as PrincipalId,
  role: 'admin',
  principalType: 'user',
  segmentIds: new Set(),
}

const memberActor: Actor = {
  principalId: 'principal_member' as PrincipalId,
  role: 'member',
  principalType: 'user',
  segmentIds: new Set(),
}

const portalUserNoSegments: Actor = {
  principalId: 'principal_user' as PrincipalId,
  role: 'user',
  principalType: 'user',
  segmentIds: new Set(),
}

const portalUserInAlpha: Actor = {
  principalId: 'principal_alpha' as PrincipalId,
  role: 'user',
  principalType: 'user',
  segmentIds: new Set(['segment_alpha' as SegmentId]),
}

const portalUserInAlphaBeta: Actor = {
  principalId: 'principal_alphabeta' as PrincipalId,
  role: 'user',
  principalType: 'user',
  segmentIds: new Set(['segment_alpha', 'segment_beta'] as SegmentId[]),
}

const servicePrincipal: Actor = {
  principalId: 'principal_svc' as PrincipalId,
  role: 'user',
  principalType: 'service',
  segmentIds: new Set(),
}

const serviceInAlpha: Actor = {
  principalId: 'principal_svc_seg' as PrincipalId,
  role: 'user',
  principalType: 'service',
  segmentIds: new Set(['segment_alpha' as SegmentId]),
}

// ----------------------------------------------------------------------
// Audience fixtures
// ----------------------------------------------------------------------

const A: Record<string, BoardAudience> = {
  public: { kind: 'public' },
  authenticated: { kind: 'authenticated' },
  team: { kind: 'team' },
  segmentAlpha: { kind: 'segments', segmentIds: ['segment_alpha'] },
  segmentBeta: { kind: 'segments', segmentIds: ['segment_beta'] },
  segmentAlphaBeta: { kind: 'segments', segmentIds: ['segment_alpha', 'segment_beta'] },
  segmentEmpty: { kind: 'segments', segmentIds: [] },
}

// ----------------------------------------------------------------------
// Matrix expressed as a table
// ----------------------------------------------------------------------

interface Row {
  name: string
  actor: Actor
  audience: BoardAudience
  expected: boolean
  reason?: string // substring expected in deny reason
}

const matrix: Row[] = [
  // ---------- public ----------
  { name: 'public + anonymous', actor: ANONYMOUS_ACTOR, audience: A.public, expected: true },
  { name: 'public + portal user', actor: portalUserNoSegments, audience: A.public, expected: true },
  { name: 'public + service', actor: servicePrincipal, audience: A.public, expected: true },
  { name: 'public + member', actor: memberActor, audience: A.public, expected: true },
  { name: 'public + admin', actor: adminActor, audience: A.public, expected: true },

  // ---------- authenticated ----------
  {
    name: 'authenticated + anonymous',
    actor: ANONYMOUS_ACTOR,
    audience: A.authenticated,
    expected: false,
    reason: 'Sign in',
  },
  {
    name: 'authenticated + portal user',
    actor: portalUserNoSegments,
    audience: A.authenticated,
    expected: true,
  },
  {
    name: 'authenticated + service principal (NOT a user)',
    actor: servicePrincipal,
    audience: A.authenticated,
    expected: false,
    reason: 'Sign in',
  },
  {
    name: 'authenticated + member always passes',
    actor: memberActor,
    audience: A.authenticated,
    expected: true,
  },
  {
    name: 'authenticated + admin always passes',
    actor: adminActor,
    audience: A.authenticated,
    expected: true,
  },

  // ---------- team ----------
  {
    name: 'team + anonymous',
    actor: ANONYMOUS_ACTOR,
    audience: A.team,
    expected: false,
    reason: 'internal',
  },
  {
    name: 'team + portal user',
    actor: portalUserNoSegments,
    audience: A.team,
    expected: false,
    reason: 'internal',
  },
  {
    name: 'team + segment-member portal user (still excluded)',
    actor: portalUserInAlpha,
    audience: A.team,
    expected: false,
    reason: 'internal',
  },
  {
    name: 'team + service (non-team service is excluded)',
    actor: servicePrincipal,
    audience: A.team,
    expected: false,
    reason: 'internal',
  },
  { name: 'team + member', actor: memberActor, audience: A.team, expected: true },
  { name: 'team + admin', actor: adminActor, audience: A.team, expected: true },

  // ---------- segments[alpha] ----------
  {
    name: 'segments[alpha] + anonymous',
    actor: ANONYMOUS_ACTOR,
    audience: A.segmentAlpha,
    expected: false,
    reason: 'restricted',
  },
  {
    name: 'segments[alpha] + portal user not in segment',
    actor: portalUserNoSegments,
    audience: A.segmentAlpha,
    expected: false,
    reason: 'restricted',
  },
  {
    name: 'segments[alpha] + portal user in alpha',
    actor: portalUserInAlpha,
    audience: A.segmentAlpha,
    expected: true,
  },
  {
    name: 'segments[alpha] + portal user in alpha+beta (any-match)',
    actor: portalUserInAlphaBeta,
    audience: A.segmentAlpha,
    expected: true,
  },
  {
    name: 'segments[alpha] + service in alpha (non-team segment members admitted)',
    actor: serviceInAlpha,
    audience: A.segmentAlpha,
    expected: true,
  },
  {
    name: 'segments[alpha] + member (team always)',
    actor: memberActor,
    audience: A.segmentAlpha,
    expected: true,
  },
  {
    name: 'segments[alpha] + admin (team always)',
    actor: adminActor,
    audience: A.segmentAlpha,
    expected: true,
  },

  // ---------- segments[beta] — confirm no false-positive ----------
  {
    name: 'segments[beta] + portal user in alpha (wrong segment)',
    actor: portalUserInAlpha,
    audience: A.segmentBeta,
    expected: false,
    reason: 'restricted',
  },

  // ---------- segments[alpha, beta] — multi-allowed ----------
  {
    name: 'segments[alpha,beta] + portal user in alpha only',
    actor: portalUserInAlpha,
    audience: A.segmentAlphaBeta,
    expected: true,
  },
  {
    name: 'segments[alpha,beta] + portal user not in either',
    actor: portalUserNoSegments,
    audience: A.segmentAlphaBeta,
    expected: false,
    reason: 'restricted',
  },

  // ---------- segments[] (empty list) — non-team should be denied ----------
  {
    name: 'segments[] empty + anonymous',
    actor: ANONYMOUS_ACTOR,
    audience: A.segmentEmpty,
    expected: false,
    reason: 'restricted',
  },
  {
    name: 'segments[] empty + portal user in alpha (no listed segment matches)',
    actor: portalUserInAlpha,
    audience: A.segmentEmpty,
    expected: false,
    reason: 'restricted',
  },
  {
    name: 'segments[] empty + admin (team always)',
    actor: adminActor,
    audience: A.segmentEmpty,
    expected: true,
  },
]

describe('canViewBoard — full audience × actor matrix', () => {
  for (const row of matrix) {
    it(row.name, () => {
      const decision = canViewBoard(row.actor, { audience: row.audience })
      if (row.expected) {
        expect(decision).toEqual({ allowed: true })
      } else {
        expect(decision.allowed).toBe(false)
        if (!decision.allowed && row.reason) {
          expect(decision.reason.toLowerCase()).toContain(row.reason.toLowerCase())
        }
      }
    })
  }
})

describe('canViewBoard — idempotence + freshness', () => {
  it('returns a fresh decision object each call (no shared state)', () => {
    const a = canViewBoard(ANONYMOUS_ACTOR, { audience: { kind: 'public' } })
    const b = canViewBoard(ANONYMOUS_ACTOR, { audience: { kind: 'public' } })
    expect(a).not.toBe(b) // different references
    expect(a).toEqual(b) // structurally equal
  })

  it('audience is the only field consulted on the board record', () => {
    // Adding noise fields must not change the answer.
    const decision = canViewBoard(portalUserInAlpha, {
      audience: { kind: 'public' },
      moderation: { requireApproval: 'all', trustedSegmentIds: [] },
      randomNoise: 'should be ignored',
    } as unknown as { audience: BoardAudience })
    expect(decision).toEqual({ allowed: true })
  })
})
