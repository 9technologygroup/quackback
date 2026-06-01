/**
 * First-party anonymous-session cookie for the widget (P2.7) — a defense-in-depth
 * complement to the localStorage Bearer token, so an anonymous session can
 * survive a same-origin reload that clears localStorage. Pure cookie policy,
 * unit-tested; the wiring (set on validate, read as a Bearer-absent fallback)
 * lives in the widget session paths.
 *
 * INVARIANTS (security-critical):
 *  - Off unless WIDGET_ANON_SESSION_COOKIE === 'true' (exact string).
 *  - HttpOnly + Secure + SameSite=Strict: not readable by JS, first-party only
 *    (a SameSite=Strict cookie is NOT sent to a cross-origin widget iframe — the
 *    complement only helps first-party/same-origin embeds, by design).
 *  - The cookie NEVER overrides an explicit Bearer token, and only ever resolves
 *    an ANONYMOUS session (enforced by the reader), so it can't elevate or
 *    poison an identified session.
 */

export const WIDGET_ANON_COOKIE_NAME = 'qb_widget_anon'

type EnvLike = Record<string, string | undefined>

export function isWidgetAnonCookieEnabled(env: EnvLike = process.env): boolean {
  return env.WIDGET_ANON_SESSION_COOKIE === 'true'
}

export function buildWidgetAnonCookie(token: string, maxAgeSeconds: number): string {
  return `${WIDGET_ANON_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`
}

/** A clearing cookie (Max-Age=0) with matching attributes. */
export function clearWidgetAnonCookie(): string {
  return `${WIDGET_ANON_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
}

/** Extract the anon-session token from a Cookie header, or null. */
export function readWidgetAnonCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === WIDGET_ANON_COOKIE_NAME) {
      return part.slice(eq + 1).trim() || null
    }
  }
  return null
}
