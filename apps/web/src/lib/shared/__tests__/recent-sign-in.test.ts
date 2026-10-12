import { describe, expect, it, vi } from 'vitest'
import { ForbiddenError } from '@/lib/shared/errors'
import {
  RECENT_SIGN_IN_REQUIRED,
  RECENT_SIGN_IN_WINDOW_MS,
  RecentSignInRequiredError,
  isRecentSignInRequired,
  toRecentSignInRefusal,
} from '../recent-sign-in'

describe('recent sign-in refusal', () => {
  it('is a ten minute window', () => {
    expect(RECENT_SIGN_IN_WINDOW_MS).toBe(10 * 60 * 1000)
  })

  it('throws a 403 domain error carrying the code', () => {
    const error = new RecentSignInRequiredError()
    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error.statusCode).toBe(403)
    expect(error.code).toBe(RECENT_SIGN_IN_REQUIRED)
  })

  it('turns the gate error into a refusal value', () => {
    expect(toRecentSignInRefusal(new RecentSignInRequiredError())).toEqual({
      ok: false,
      code: RECENT_SIGN_IN_REQUIRED,
      message: expect.any(String),
    })
  })

  it('recognises the gate error from a second copy of this module', async () => {
    vi.resetModules()
    const second = await import('../recent-sign-in')
    expect(second.RecentSignInRequiredError).not.toBe(RecentSignInRequiredError)
    expect(toRecentSignInRefusal(new second.RecentSignInRequiredError())).toEqual({
      ok: false,
      code: RECENT_SIGN_IN_REQUIRED,
      message: expect.any(String),
    })
  })

  it('recognises any domain error carrying the code', () => {
    expect(
      toRecentSignInRefusal(new ForbiddenError(RECENT_SIGN_IN_REQUIRED, 'Sign in again.'))
    ).toEqual({ ok: false, code: RECENT_SIGN_IN_REQUIRED, message: 'Sign in again.' })
  })

  it('leaves every other error alone', () => {
    expect(toRecentSignInRefusal(new ForbiddenError('GRANT_CEILING', 'no'))).toBeNull()
    expect(toRecentSignInRefusal(new Error(RECENT_SIGN_IN_REQUIRED))).toBeNull()
    expect(toRecentSignInRefusal(null)).toBeNull()
  })

  it('recognises the refusal value and nothing else', () => {
    expect(isRecentSignInRequired(toRecentSignInRefusal(new RecentSignInRequiredError()))).toBe(
      true
    )
    expect(isRecentSignInRequired({ ok: false, code: 'GRANT_CEILING', message: 'x' })).toBe(false)
    expect(isRecentSignInRequired({ ok: true, code: RECENT_SIGN_IN_REQUIRED })).toBe(false)
    expect(isRecentSignInRequired(undefined)).toBe(false)
    expect(isRecentSignInRequired('RECENT_SIGN_IN_REQUIRED')).toBe(false)
  })
})
