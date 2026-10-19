/**
 * Whether the person signed in recently is read off the moment the session was
 * created by a sign-in. A session refresh moves `updatedAt` (and the expiry)
 * forward but never `createdAt`, so an old session that keeps being used is
 * still an old sign-in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RECENT_SIGN_IN_REQUIRED, RECENT_SIGN_IN_WINDOW_MS } from '@/lib/shared/recent-sign-in'

const hoisted = vi.hoisted(() => ({ getRequestSession: vi.fn() }))
vi.mock('@/lib/server/auth/request-session', () => ({
  getRequestSession: () => hoisted.getRequestSession(),
}))

const { isRecentSignIn, hasRecentSignIn, requireRecentSignIn } = await import('../recent-sign-in')

const NOW = new Date('2026-10-12T12:00:00Z').getTime()
const minutesAgo = (m: number) => new Date(NOW - m * 60 * 1000)

function session(opts: {
  createdAt: Date
  updatedAt?: Date
  scope?: string
  userId?: string
  isAnonymous?: boolean
}) {
  return {
    session: {
      id: 'sess_1',
      createdAt: opts.createdAt,
      updatedAt: opts.updatedAt ?? opts.createdAt,
      expiresAt: new Date(NOW + 7 * 24 * 60 * 60 * 1000),
      scope: opts.scope ?? 'dashboard',
      userId: opts.userId ?? 'user_me',
    },
    user: { id: opts.userId ?? 'user_me', isAnonymous: opts.isAnonymous ?? false },
  }
}

describe('isRecentSignIn', () => {
  it('counts a sign-in 5 minutes ago', () => {
    expect(isRecentSignIn(session({ createdAt: minutesAgo(5) }), NOW)).toBe(true)
  })

  it('does not count a sign-in 11 minutes ago', () => {
    expect(isRecentSignIn(session({ createdAt: minutesAgo(11) }), NOW)).toBe(false)
  })

  it('does not count an old session that was refreshed a moment ago', () => {
    const refreshed = session({ createdAt: minutesAgo(3 * 24 * 60), updatedAt: minutesAgo(0) })
    expect(isRecentSignIn(refreshed, NOW)).toBe(false)
  })

  it('ends exactly at the window', () => {
    const edge = session({ createdAt: new Date(NOW - RECENT_SIGN_IN_WINDOW_MS) })
    expect(isRecentSignIn(edge, NOW)).toBe(false)
    const inside = session({ createdAt: new Date(NOW - RECENT_SIGN_IN_WINDOW_MS + 1000) })
    expect(isRecentSignIn(inside, NOW)).toBe(true)
  })

  it('reads ISO strings as well as dates', () => {
    const iso = session({ createdAt: minutesAgo(2) })
    expect(
      isRecentSignIn(
        { ...iso, session: { ...iso.session, createdAt: minutesAgo(2).toISOString() } },
        NOW
      )
    ).toBe(true)
  })

  it('does not count a session the app minted without a sign-in', () => {
    expect(isRecentSignIn(session({ createdAt: minutesAgo(1), scope: 'widget' }), NOW)).toBe(false)
    expect(isRecentSignIn(session({ createdAt: minutesAgo(1), scope: 'portal' }), NOW)).toBe(false)
    expect(isRecentSignIn(session({ createdAt: minutesAgo(1), isAnonymous: true }), NOW)).toBe(
      false
    )
  })

  it('does not count a missing or unreadable session', () => {
    expect(isRecentSignIn(null, NOW)).toBe(false)
    expect(isRecentSignIn(session({ createdAt: new Date('nope') }), NOW)).toBe(false)
  })

  it('does not count a creation time far in the future', () => {
    expect(isRecentSignIn(session({ createdAt: minutesAgo(-30) }), NOW)).toBe(false)
  })
})

describe('requireRecentSignIn', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    hoisted.getRequestSession.mockReset()
  })

  it('passes a person who signed in recently', async () => {
    hoisted.getRequestSession.mockResolvedValue(session({ createdAt: minutesAgo(5) }))
    await expect(requireRecentSignIn({ user: { id: 'user_me' } })).resolves.toBeUndefined()
    expect(await hasRecentSignIn()).toBe(true)
  })

  it('refuses a stale session with the recognisable code', async () => {
    hoisted.getRequestSession.mockResolvedValue(session({ createdAt: minutesAgo(11) }))
    await expect(requireRecentSignIn()).rejects.toMatchObject({
      code: RECENT_SIGN_IN_REQUIRED,
      statusCode: 403,
    })
    expect(await hasRecentSignIn()).toBe(false)
  })

  it('refuses a refreshed old session', async () => {
    hoisted.getRequestSession.mockResolvedValue(
      session({ createdAt: minutesAgo(60), updatedAt: minutesAgo(0) })
    )
    await expect(requireRecentSignIn()).rejects.toMatchObject({ code: RECENT_SIGN_IN_REQUIRED })
  })

  it('refuses when there is no session', async () => {
    hoisted.getRequestSession.mockResolvedValue(null)
    await expect(requireRecentSignIn()).rejects.toMatchObject({ code: RECENT_SIGN_IN_REQUIRED })
  })

  it('refuses when the session is not the person the caller authorised', async () => {
    hoisted.getRequestSession.mockResolvedValue(
      session({ createdAt: minutesAgo(1), userId: 'user_other' })
    )
    await expect(requireRecentSignIn({ user: { id: 'user_me' } })).rejects.toMatchObject({
      code: RECENT_SIGN_IN_REQUIRED,
    })
    expect(await hasRecentSignIn({ user: { id: 'user_me' } })).toBe(false)
  })
})
