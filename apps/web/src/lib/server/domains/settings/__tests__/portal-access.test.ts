/**
 * Unit tests for evaluatePortalAccess().
 *
 * Pure function — no DB, no mocks needed.
 */
import { describe, it, expect } from 'vitest'
import { evaluatePortalAccess } from '../portal-access'

describe('evaluatePortalAccess — public portal', () => {
  it('always grants when visibility is public, no session', () => {
    const result = evaluatePortalAccess({
      visibility: 'public',
      role: null,
      isAuthenticated: false,
      userEmail: null,
      emailVerified: false,
      allowedDomains: [],
    })
    expect(result.granted).toBe(true)
    if (result.granted) {
      expect(result.reason).toBe('public')
    }
  })

  it('always grants when visibility is public, even for anonymous session', () => {
    const result = evaluatePortalAccess({
      visibility: 'public',
      role: null,
      isAuthenticated: false,
      userEmail: null,
      emailVerified: false,
      allowedDomains: [],
    })
    expect(result.granted).toBe(true)
  })
})

describe('evaluatePortalAccess — private portal, team members', () => {
  it('grants access for admin', () => {
    const result = evaluatePortalAccess({
      visibility: 'private',
      role: 'admin',
      isAuthenticated: true,
      userEmail: 'admin@example.com',
      emailVerified: true,
      allowedDomains: [],
    })
    expect(result.granted).toBe(true)
    if (result.granted) {
      expect(result.reason).toBe('team')
    }
  })

  it('grants access for member', () => {
    const result = evaluatePortalAccess({
      visibility: 'private',
      role: 'member',
      isAuthenticated: true,
      userEmail: 'member@example.com',
      emailVerified: true,
      allowedDomains: [],
    })
    expect(result.granted).toBe(true)
    if (result.granted) {
      expect(result.reason).toBe('team')
    }
  })

  it('does NOT grant via team branch for anonymous principal with a team role', () => {
    // Defense-in-depth: an anonymous principal carrying a team role must NOT
    // be granted access via the team branch. isAuthenticated=false ensures
    // the evaluator does not treat this as a real team member.
    const result = evaluatePortalAccess({
      visibility: 'private',
      role: 'admin',
      isAuthenticated: false,
      userEmail: null,
      emailVerified: false,
      allowedDomains: [],
    })
    expect(result.granted).toBe(false)
    if (!result.granted) {
      expect(result.reason).toBe('unauthenticated')
    }
  })
})

describe('evaluatePortalAccess — private portal, non-team', () => {
  it('returns unauthenticated when no session (anonymous)', () => {
    const result = evaluatePortalAccess({
      visibility: 'private',
      role: null,
      isAuthenticated: false,
      userEmail: null,
      emailVerified: false,
      allowedDomains: [],
    })
    expect(result.granted).toBe(false)
    if (!result.granted) {
      expect(result.reason).toBe('unauthenticated')
    }
  })

  it('returns unauthenticated when principal is anonymous (anonymous Better Auth session)', () => {
    const result = evaluatePortalAccess({
      visibility: 'private',
      role: null,
      isAuthenticated: false,
      userEmail: null,
      emailVerified: false,
      allowedDomains: [],
    })
    expect(result.granted).toBe(false)
    if (!result.granted) {
      expect(result.reason).toBe('unauthenticated')
    }
  })

  it('returns unauthorized for authenticated portal user (role=user)', () => {
    const result = evaluatePortalAccess({
      visibility: 'private',
      role: 'user',
      isAuthenticated: true,
      userEmail: 'user@notlisted.com',
      emailVerified: true,
      allowedDomains: [],
    })
    expect(result.granted).toBe(false)
    if (!result.granted) {
      expect(result.reason).toBe('unauthorized')
    }
  })
})

describe('evaluatePortalAccess — private portal, allowed email domains', () => {
  it('grants access when verified email domain is on the allowlist', () => {
    const result = evaluatePortalAccess({
      visibility: 'private',
      role: 'user',
      isAuthenticated: true,
      userEmail: 'alice@acme.com',
      emailVerified: true,
      allowedDomains: ['acme.com'],
    })
    expect(result.granted).toBe(true)
    if (result.granted) {
      expect(result.reason).toBe('domain')
    }
  })

  it('denies access when email domain matches but email is NOT verified', () => {
    const result = evaluatePortalAccess({
      visibility: 'private',
      role: 'user',
      isAuthenticated: true,
      userEmail: 'alice@acme.com',
      emailVerified: false,
      allowedDomains: ['acme.com'],
    })
    expect(result.granted).toBe(false)
    if (!result.granted) {
      expect(result.reason).toBe('unauthorized')
    }
  })

  it('denies access when authenticated but domain is not on the allowlist', () => {
    const result = evaluatePortalAccess({
      visibility: 'private',
      role: 'user',
      isAuthenticated: true,
      userEmail: 'bob@other.com',
      emailVerified: true,
      allowedDomains: ['acme.com'],
    })
    expect(result.granted).toBe(false)
    if (!result.granted) {
      expect(result.reason).toBe('unauthorized')
    }
  })

  it('denies when unauthenticated even though domain would match', () => {
    const result = evaluatePortalAccess({
      visibility: 'private',
      role: null,
      isAuthenticated: false,
      userEmail: 'alice@acme.com',
      emailVerified: true,
      allowedDomains: ['acme.com'],
    })
    expect(result.granted).toBe(false)
    if (!result.granted) {
      expect(result.reason).toBe('unauthenticated')
    }
  })

  it('domain match is case-insensitive for the email', () => {
    const result = evaluatePortalAccess({
      visibility: 'private',
      role: 'user',
      isAuthenticated: true,
      userEmail: 'Alice@ACME.COM',
      emailVerified: true,
      allowedDomains: ['acme.com'],
    })
    expect(result.granted).toBe(true)
    if (result.granted) {
      expect(result.reason).toBe('domain')
    }
  })

  it('grants access via domain even when allowedDomains has multiple entries', () => {
    const result = evaluatePortalAccess({
      visibility: 'private',
      role: 'user',
      isAuthenticated: true,
      userEmail: 'carol@partner.io',
      emailVerified: true,
      allowedDomains: ['acme.com', 'partner.io', 'another.org'],
    })
    expect(result.granted).toBe(true)
    if (result.granted) {
      expect(result.reason).toBe('domain')
    }
  })

  it('public portal grants regardless of allowedDomains being empty', () => {
    const result = evaluatePortalAccess({
      visibility: 'public',
      role: null,
      isAuthenticated: false,
      userEmail: null,
      emailVerified: false,
      allowedDomains: [],
    })
    expect(result.granted).toBe(true)
    if (result.granted) {
      expect(result.reason).toBe('public')
    }
  })
})
