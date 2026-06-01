import { describe, it, expect } from 'vitest'
import {
  WIDGET_ANON_COOKIE_NAME,
  isWidgetAnonCookieEnabled,
  buildWidgetAnonCookie,
  clearWidgetAnonCookie,
  readWidgetAnonCookie,
} from '../widget-anon-cookie'

describe('isWidgetAnonCookieEnabled', () => {
  it('is true only for the exact string "true"', () => {
    expect(isWidgetAnonCookieEnabled({ WIDGET_ANON_SESSION_COOKIE: 'true' })).toBe(true)
    expect(isWidgetAnonCookieEnabled({ WIDGET_ANON_SESSION_COOKIE: '1' })).toBe(false)
    expect(isWidgetAnonCookieEnabled({ WIDGET_ANON_SESSION_COOKIE: '' })).toBe(false)
    expect(isWidgetAnonCookieEnabled({})).toBe(false)
  })
})

describe('buildWidgetAnonCookie', () => {
  it('sets the security-critical attributes (HttpOnly, Secure, SameSite=Strict)', () => {
    const c = buildWidgetAnonCookie('tok_abc', 604800)
    expect(c.startsWith(`${WIDGET_ANON_COOKIE_NAME}=tok_abc;`)).toBe(true)
    expect(c).toContain('HttpOnly')
    expect(c).toContain('Secure')
    expect(c).toContain('SameSite=Strict')
    expect(c).toContain('Max-Age=604800')
    expect(c).toContain('Path=/')
  })

  it('clears with Max-Age=0', () => {
    expect(clearWidgetAnonCookie()).toContain('Max-Age=0')
  })
})

describe('readWidgetAnonCookie', () => {
  it('extracts the token from a Cookie header among other cookies', () => {
    expect(readWidgetAnonCookie(`other=1; ${WIDGET_ANON_COOKIE_NAME}=tok_xyz; foo=bar`)).toBe(
      'tok_xyz'
    )
  })

  it('returns null when absent, empty, or no header', () => {
    expect(readWidgetAnonCookie('other=1; foo=bar')).toBeNull()
    expect(readWidgetAnonCookie(`${WIDGET_ANON_COOKIE_NAME}=`)).toBeNull()
    expect(readWidgetAnonCookie(null)).toBeNull()
    expect(readWidgetAnonCookie(undefined)).toBeNull()
  })
})
