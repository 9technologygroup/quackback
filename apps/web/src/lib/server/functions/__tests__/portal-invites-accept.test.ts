/**
 * Unit tests for acceptPortalInviteFn.
 *
 * Covers the happy path, idempotent re-accept, terminal states (canceled /
 * expired), the security-critical email-mismatch check, and auth-required gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// createServerFn stub
// ---------------------------------------------------------------------------

type AnyHandler = (args: { data: Record<string, unknown> }) => Promise<unknown>

// Handlers are registered in file-definition order. portal-invites.ts already
// registers 4 handlers before acceptPortalInviteFn (send, cancel, resend,
// fetch), so we capture all of them here.
const handlers: AnyHandler[] = []

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const chain = {
      inputValidator() {
        return chain
      },
      handler(fn: AnyHandler) {
        handlers.push(fn)
        return chain
      },
    }
    return chain
  },
}))

vi.mock('@tanstack/react-start/server', () => ({
  getRequestHeaders: () => new Headers(),
}))

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockRequireAuth: vi.fn(),
  mockRecordAuditEvent: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbQuery: {
    invitation: { findFirst: vi.fn() },
    principal: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
  },
  mockDbInsert: vi.fn(),
  mockSendPortalInviteEmail: vi.fn(),
  mockMintMagicLinkUrl: vi.fn(),
  mockGetEmailSafeUrl: vi.fn(),
  mockGetBaseUrl: vi.fn(),
  mockGenerateId: vi.fn(),
}))

vi.mock('@/lib/server/auth/session', () => ({
  getSession: hoisted.mockGetSession,
}))

vi.mock('@/lib/server/functions/auth-helpers', () => ({
  requireAuth: hoisted.mockRequireAuth,
}))

vi.mock('@/lib/server/audit/log', () => ({
  recordAuditEvent: hoisted.mockRecordAuditEvent,
  actorFromAuth: (auth: { user: { id: string; email: string }; principal: { role: string } }) => ({
    userId: auth.user.id,
    email: auth.user.email,
    role: auth.principal.role,
  }),
}))

vi.mock('@/lib/server/db', () => {
  const insertChain = { values: hoisted.mockDbInsert }
  const updateChain = {
    set: () => ({ where: hoisted.mockDbUpdate }),
  }
  return {
    db: {
      query: hoisted.mockDbQuery,
      insert: () => insertChain,
      update: () => updateChain,
    },
    invitation: { id: 'id', email: 'email', kind: 'kind', status: 'status' },
    principal: { userId: 'userId', role: 'role', id: 'id' },
    user: { email: 'email', id: 'id' },
    eq: vi.fn((col, val) => ({ col, val })),
    and: vi.fn((...args: unknown[]) => args),
    or: vi.fn((...args: unknown[]) => args),
    sql: vi.fn((parts: TemplateStringsArray) => parts.raw[0]),
  }
})

vi.mock('@quackback/email', () => ({
  sendPortalInviteEmail: hoisted.mockSendPortalInviteEmail,
}))

vi.mock('@/lib/server/config', () => ({
  getBaseUrl: hoisted.mockGetBaseUrl,
}))

vi.mock('@quackback/ids', () => ({
  generateId: hoisted.mockGenerateId,
}))

vi.mock('@/lib/server/auth/magic-link-mint', () => ({
  mintMagicLinkUrl: hoisted.mockMintMagicLinkUrl,
}))

vi.mock('@/lib/server/storage/s3', () => ({
  getEmailSafeUrl: hoisted.mockGetEmailSafeUrl,
}))

// ---------------------------------------------------------------------------
// Handler index — accept is the 5th handler (index 4)
// ---------------------------------------------------------------------------

const ACCEPT_IDX = 4

const FUTURE = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
const PAST = new Date(Date.now() - 1000)

const SESSION_USER = {
  id: 'user_invitee',
  email: 'invitee@example.com',
  name: 'Invitee',
  emailVerified: true,
  image: null,
  principalType: 'user' as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const PENDING_INVITE = {
  id: 'invite_1',
  email: 'invitee@example.com',
  kind: 'portal',
  status: 'pending',
  expiresAt: FUTURE,
}

let acceptHandler: AnyHandler

beforeEach(async () => {
  vi.clearAllMocks()

  if (handlers.length === 0) {
    await import('../portal-invites')
  }

  acceptHandler = handlers[ACCEPT_IDX] as AnyHandler

  // Defaults
  hoisted.mockGetSession.mockResolvedValue({
    session: {
      id: 'sess_1',
      userId: SESSION_USER.id,
      expiresAt: FUTURE.toISOString(),
      token: 't',
      createdAt: '',
      updatedAt: '',
    },
    user: SESSION_USER,
  })
  hoisted.mockDbQuery.invitation.findFirst.mockResolvedValue(PENDING_INVITE)
  hoisted.mockDbQuery.principal.findFirst.mockResolvedValue(null)
  hoisted.mockDbUpdate.mockResolvedValue(undefined)
  hoisted.mockRecordAuditEvent.mockResolvedValue(undefined)
  hoisted.mockRequireAuth.mockResolvedValue(undefined)
  hoisted.mockSendPortalInviteEmail.mockResolvedValue({ sent: false })
  hoisted.mockGetBaseUrl.mockReturnValue('https://example.com')
  hoisted.mockGenerateId.mockReturnValue('invite_new')
  hoisted.mockDbInsert.mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe('acceptPortalInviteFn — auth gate', () => {
  it('throws when there is no session', async () => {
    hoisted.mockGetSession.mockResolvedValue(null)

    await expect(acceptHandler({ data: { inviteId: 'invite_1' } })).rejects.toThrow(
      'Authentication required'
    )
  })

  it('throws when session has no user', async () => {
    hoisted.mockGetSession.mockResolvedValue({ session: {}, user: null })

    await expect(acceptHandler({ data: { inviteId: 'invite_1' } })).rejects.toThrow(
      'Authentication required'
    )
  })
})

// ---------------------------------------------------------------------------
// Not found
// ---------------------------------------------------------------------------

describe('acceptPortalInviteFn — not found', () => {
  it('throws PORTAL_INVITE_NOT_FOUND when invite does not exist', async () => {
    hoisted.mockDbQuery.invitation.findFirst.mockResolvedValue(null)

    await expect(acceptHandler({ data: { inviteId: 'invite_missing' } })).rejects.toThrow(
      'PORTAL_INVITE_NOT_FOUND'
    )
  })
})

// ---------------------------------------------------------------------------
// Terminal states
// ---------------------------------------------------------------------------

describe('acceptPortalInviteFn — terminal states', () => {
  it('returns { status: canceled } without accepting', async () => {
    hoisted.mockDbQuery.invitation.findFirst.mockResolvedValue({
      ...PENDING_INVITE,
      status: 'canceled',
    })

    const result = await acceptHandler({ data: { inviteId: 'invite_1' } })
    expect((result as { status: string }).status).toBe('canceled')
    expect(hoisted.mockDbUpdate).not.toHaveBeenCalled()
  })

  it('returns { status: expired } without accepting', async () => {
    hoisted.mockDbQuery.invitation.findFirst.mockResolvedValue({
      ...PENDING_INVITE,
      status: 'pending',
      expiresAt: PAST,
    })

    const result = await acceptHandler({ data: { inviteId: 'invite_1' } })
    expect((result as { status: string }).status).toBe('expired')
    expect(hoisted.mockDbUpdate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Idempotent re-accept
// ---------------------------------------------------------------------------

describe('acceptPortalInviteFn — idempotent', () => {
  it('returns alreadyAccepted=true when invite is already accepted', async () => {
    hoisted.mockDbQuery.invitation.findFirst.mockResolvedValue({
      ...PENDING_INVITE,
      status: 'accepted',
    })

    const result = await acceptHandler({ data: { inviteId: 'invite_1' } })
    const r = result as { status: string; alreadyAccepted: boolean }
    expect(r.status).toBe('accepted')
    expect(r.alreadyAccepted).toBe(true)
  })

  it('does NOT record a second audit event on re-accept', async () => {
    hoisted.mockDbQuery.invitation.findFirst.mockResolvedValue({
      ...PENDING_INVITE,
      status: 'accepted',
    })

    await acceptHandler({ data: { inviteId: 'invite_1' } })
    expect(hoisted.mockRecordAuditEvent).not.toHaveBeenCalled()
  })

  it('does NOT call db update on re-accept', async () => {
    hoisted.mockDbQuery.invitation.findFirst.mockResolvedValue({
      ...PENDING_INVITE,
      status: 'accepted',
    })

    await acceptHandler({ data: { inviteId: 'invite_1' } })
    expect(hoisted.mockDbUpdate).not.toHaveBeenCalled()
  })

  it('returns mismatch (not alreadyAccepted) when caller email differs on an already-accepted invite', async () => {
    // Invite is accepted, but the calling session belongs to a different user.
    // The email-mismatch guard must run before the alreadyAccepted short-circuit.
    hoisted.mockDbQuery.invitation.findFirst.mockResolvedValue({
      ...PENDING_INVITE,
      status: 'accepted',
    })
    hoisted.mockGetSession.mockResolvedValue({
      session: { id: 'sess_1', userId: 'user_other' },
      user: { ...SESSION_USER, id: 'user_other', email: 'wrong@example.com' },
    })

    const result = await acceptHandler({ data: { inviteId: 'invite_1' } })
    expect((result as { status: string }).status).toBe('mismatch')
  })
})

// ---------------------------------------------------------------------------
// Email mismatch — security-critical
// ---------------------------------------------------------------------------

describe('acceptPortalInviteFn — email mismatch (security)', () => {
  it('returns { status: mismatch } when session email does not match', async () => {
    hoisted.mockGetSession.mockResolvedValue({
      session: { id: 'sess_1', userId: 'user_other' },
      user: { ...SESSION_USER, id: 'user_other', email: 'other@example.com' },
    })

    const result = await acceptHandler({ data: { inviteId: 'invite_1' } })
    expect((result as { status: string }).status).toBe('mismatch')
  })

  it('does NOT update the invite on mismatch', async () => {
    hoisted.mockGetSession.mockResolvedValue({
      session: { id: 'sess_1', userId: 'user_other' },
      user: { ...SESSION_USER, id: 'user_other', email: 'other@example.com' },
    })

    await acceptHandler({ data: { inviteId: 'invite_1' } })
    expect(hoisted.mockDbUpdate).not.toHaveBeenCalled()
  })

  it('does NOT record an audit event on mismatch', async () => {
    hoisted.mockGetSession.mockResolvedValue({
      session: { id: 'sess_1', userId: 'user_other' },
      user: { ...SESSION_USER, id: 'user_other', email: 'other@example.com' },
    })

    await acceptHandler({ data: { inviteId: 'invite_1' } })
    expect(hoisted.mockRecordAuditEvent).not.toHaveBeenCalled()
  })

  it('comparison is case-insensitive — uppercase session email matches lowercase invite', async () => {
    // Invite has lowercase; session has uppercase — should match, not mismatch.
    hoisted.mockGetSession.mockResolvedValue({
      session: { id: 'sess_1', userId: SESSION_USER.id },
      user: { ...SESSION_USER, email: 'INVITEE@EXAMPLE.COM' },
    })

    const result = await acceptHandler({ data: { inviteId: 'invite_1' } })
    const r = result as { status: string; alreadyAccepted: boolean }
    expect(r.status).toBe('accepted')
    expect(r.alreadyAccepted).toBe(false)
  })

  it('comparison is case-insensitive — uppercase invite email matches lowercase session', async () => {
    hoisted.mockDbQuery.invitation.findFirst.mockResolvedValue({
      ...PENDING_INVITE,
      email: 'INVITEE@EXAMPLE.COM',
    })
    // Session has lowercase
    const result = await acceptHandler({ data: { inviteId: 'invite_1' } })
    const r = result as { status: string; alreadyAccepted: boolean }
    expect(r.status).toBe('accepted')
    expect(r.alreadyAccepted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('acceptPortalInviteFn — happy path', () => {
  it('returns { status: accepted, alreadyAccepted: false }', async () => {
    const result = await acceptHandler({ data: { inviteId: 'invite_1' } })
    const r = result as { status: string; alreadyAccepted: boolean }
    expect(r.status).toBe('accepted')
    expect(r.alreadyAccepted).toBe(false)
  })

  it('updates invite status to accepted', async () => {
    await acceptHandler({ data: { inviteId: 'invite_1' } })
    expect(hoisted.mockDbUpdate).toHaveBeenCalled()
  })

  it('records a portal.invite.accepted audit event', async () => {
    await acceptHandler({ data: { inviteId: 'invite_1' } })

    const auditCall = hoisted.mockRecordAuditEvent.mock.calls.find(
      (c) => (c[0] as { event: string }).event === 'portal.invite.accepted'
    )
    expect(auditCall).toBeDefined()
  })

  it('includes the invite email in the audit after-value', async () => {
    await acceptHandler({ data: { inviteId: 'invite_1' } })

    const auditCall = hoisted.mockRecordAuditEvent.mock.calls.find(
      (c) => (c[0] as { event: string }).event === 'portal.invite.accepted'
    )
    const after = (auditCall![0] as { after: { email: string } }).after
    expect(after.email).toBe(PENDING_INVITE.email)
  })
})
