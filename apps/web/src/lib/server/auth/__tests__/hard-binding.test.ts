/**
 * Tests for `isHardBoundByVerifiedDomain` — gates `hooks.before` redirects.
 *
 * Hard-binding is the strong promise: verified-domain emails must use SSO;
 * password / magic-link / non-SSO OAuth are rejected for them. The promise
 * only applies when the matching verified-domain row has `enforced=true`.
 * Without per-row enforcement, verification is routing-only and other
 * methods stay open.
 */

import { describe, it, expect } from 'vitest'
import { isHardBoundByVerifiedDomain } from '../auth-restrictions'
import type { VerifiedDomain } from '@/lib/server/domains/settings/settings.types'

const verifiedDomain = (name: string, overrides: Partial<VerifiedDomain> = {}): VerifiedDomain => ({
  id: 'domain_test' as `domain_${string}`,
  name,
  verificationToken: 'tok',
  verifiedAt: '2026-05-10T00:00:00.000Z',
  enforced: false,
  createdAt: '2026-05-10T00:00:00.000Z',
  ...overrides,
})

const enforced = (name: string) => verifiedDomain(name, { enforced: true })
const unenforced = (name: string) => verifiedDomain(name, { enforced: false })

describe('isHardBoundByVerifiedDomain — enforcement on', () => {
  it('blocks password (credential) for verified-domain email', () => {
    expect(
      isHardBoundByVerifiedDomain('credential', 'alice@acme.com', [enforced('acme.com')])
    ).toBe(true)
  })

  it('blocks magic-link for verified-domain email', () => {
    expect(
      isHardBoundByVerifiedDomain('magic-link', 'alice@acme.com', [enforced('acme.com')])
    ).toBe(true)
  })

  it('does NOT block sso itself (the allowed path)', () => {
    expect(isHardBoundByVerifiedDomain('sso', 'alice@acme.com', [enforced('acme.com')])).toBe(false)
  })

  it('does NOT block other OAuth providers (callback layer handles those)', () => {
    expect(isHardBoundByVerifiedDomain('google', 'alice@acme.com', [enforced('acme.com')])).toBe(
      false
    )
    expect(isHardBoundByVerifiedDomain('github', 'alice@acme.com', [enforced('acme.com')])).toBe(
      false
    )
  })

  it('does NOT block magic-link for non-verified-domain emails (break-glass)', () => {
    expect(
      isHardBoundByVerifiedDomain('magic-link', 'admin@backup.io', [enforced('acme.com')])
    ).toBe(false)
  })

  it('does NOT block credential for non-verified-domain emails', () => {
    expect(
      isHardBoundByVerifiedDomain('credential', 'admin@backup.io', [enforced('acme.com')])
    ).toBe(false)
  })

  it('does NOT block when the matching row is pending (verifiedAt null)', () => {
    const pending = verifiedDomain('acme.com', { verifiedAt: null, enforced: true })
    expect(isHardBoundByVerifiedDomain('credential', 'alice@acme.com', [pending])).toBe(false)
    expect(isHardBoundByVerifiedDomain('magic-link', 'alice@acme.com', [pending])).toBe(false)
  })

  it('case-insensitive domain match for magic-link', () => {
    expect(
      isHardBoundByVerifiedDomain('magic-link', 'Alice@Acme.COM', [enforced('acme.com')])
    ).toBe(true)
  })

  it('blocks for one enforced row even when other rows in the list are not enforced', () => {
    const rows = [unenforced('acme.io'), enforced('acme.com'), unenforced('acquired.com')]
    expect(isHardBoundByVerifiedDomain('credential', 'alice@acme.com', rows)).toBe(true)
    expect(isHardBoundByVerifiedDomain('credential', 'alice@acme.io', rows)).toBe(false)
    expect(isHardBoundByVerifiedDomain('credential', 'alice@acquired.com', rows)).toBe(false)
  })
})

describe('isHardBoundByVerifiedDomain — enforcement off', () => {
  it('does NOT block password for verified-but-not-enforced domain (routing-only)', () => {
    expect(
      isHardBoundByVerifiedDomain('credential', 'alice@acme.com', [unenforced('acme.com')])
    ).toBe(false)
  })

  it('does NOT block magic-link for verified-but-not-enforced domain (routing-only)', () => {
    expect(
      isHardBoundByVerifiedDomain('magic-link', 'alice@acme.com', [unenforced('acme.com')])
    ).toBe(false)
  })

  it('returns false for an empty verifiedDomains array', () => {
    expect(isHardBoundByVerifiedDomain('credential', 'alice@acme.com', [])).toBe(false)
    expect(isHardBoundByVerifiedDomain('magic-link', 'alice@acme.com', [])).toBe(false)
  })

  it('returns false for an undefined verifiedDomains', () => {
    expect(isHardBoundByVerifiedDomain('credential', 'alice@acme.com', undefined)).toBe(false)
  })
})
