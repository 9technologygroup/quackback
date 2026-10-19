/**
 * The page-side half of signing in again: where the sign-in comes back to,
 * how the page knows it came back, and what it resumes.
 *
 * The return address is the current page with a `signedInAgain=<action>`
 * search parameter. A sign-in that fails comes back to the same address with
 * the `error` parameter the auth server appends. Before the browser leaves for
 * an identity provider, the action and the person it was for are kept in this
 * tab's session storage; the page resumes only when the marker, that stash and
 * the person now signed in all agree. A sign-in link opened in another tab
 * lands there with the marker but without the stash, so it never resumes the
 * action twice; the tab that asked notices the sign-in instead.
 */
import { RECENT_SIGN_IN_WINDOW_MS } from '@/lib/shared/recent-sign-in'
import type { SignInAgainProvider } from '@/lib/shared/sign-in-again'

/** The search parameter that marks a page reached by signing in again. */
export const SIGN_IN_AGAIN_PARAM = 'signedInAgain'

/** Parameters the auth server appends to the return address on failure. */
const ERROR_PARAMS = ['error', 'error_description']

const STASH_KEY = 'quackback:sign-in-again'

/** The current page as a same-origin path, marked with `action`. The hash is
 *  left off: the auth server appends its error after the address it is given. */
export function signInAgainReturnUrl(href: string, action: string): string {
  const url = new URL(href)
  url.searchParams.delete(SIGN_IN_AGAIN_PARAM)
  for (const param of ERROR_PARAMS) url.searchParams.delete(param)
  url.searchParams.set(SIGN_IN_AGAIN_PARAM, action)
  return url.pathname + url.search
}

export interface SignInAgainMarker {
  action: string
  /** The auth server's error code when the sign-in failed. */
  error: string | null
}

/** The marker on a page reached by signing in again, or null. */
export function readSignInAgainMarker(href: string): SignInAgainMarker | null {
  const url = new URL(href)
  const action = url.searchParams.get(SIGN_IN_AGAIN_PARAM)
  if (!action) return null
  return { action, error: url.searchParams.get('error') }
}

/** The page as a same-origin path without the marker and the error that came with it. */
export function withoutSignInAgainMarker(href: string): string {
  const url = new URL(href)
  if (url.searchParams.has(SIGN_IN_AGAIN_PARAM)) {
    url.searchParams.delete(SIGN_IN_AGAIN_PARAM)
    for (const param of ERROR_PARAMS) url.searchParams.delete(param)
  }
  return url.pathname + url.search + url.hash
}

/** A page's search without the marker and the error that came with it; unchanged without a marker. */
export function stripSignInAgainSearch(search: Record<string, unknown>): Record<string, unknown> {
  if (!(SIGN_IN_AGAIN_PARAM in search)) return search
  const next = { ...search }
  delete next[SIGN_IN_AGAIN_PARAM]
  for (const param of ERROR_PARAMS) delete next[param]
  return next
}

export interface SignInAgainStash {
  action: string
  /** The person who asked; a sign-in as anyone else resumes nothing. */
  userId: string
  startedAt: number
}

function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

/** Remember the action and the person before leaving for an identity provider. */
export function stashSignInAgain(
  stash: Omit<SignInAgainStash, 'startedAt'>,
  storage: Storage | null = sessionStore(),
  now: number = Date.now()
): void {
  try {
    storage?.setItem(STASH_KEY, JSON.stringify({ ...stash, startedAt: now }))
  } catch {
    // Without storage the page cannot resume; the person asks again instead.
  }
}

/** The stash for `action`, removed as it is read; null when absent, another action's or stale. */
export function takeSignInAgain(
  action: string,
  storage: Storage | null = sessionStore(),
  now: number = Date.now()
): SignInAgainStash | null {
  try {
    const raw = storage?.getItem(STASH_KEY)
    if (!raw) return null
    storage?.removeItem(STASH_KEY)
    const stash = JSON.parse(raw) as Partial<SignInAgainStash>
    if (stash.action !== action || typeof stash.userId !== 'string') return null
    if (typeof stash.startedAt !== 'number') return null
    if (now - stash.startedAt > RECENT_SIGN_IN_WINDOW_MS) return null
    return { action: stash.action, userId: stash.userId, startedAt: stash.startedAt }
  } catch {
    return null
  }
}

export interface SignInAgainProviderRequest {
  providerId: string
  callbackURL: string
  errorCallbackURL: string
  loginHint?: string
}

/**
 * The sign-in request for an identity provider. It sends nothing that changes
 * how the provider asks: the provider's own configured prompt applies, never a
 * forced `prompt=login`, `max_age=0` or account picker, which some providers
 * reject. An OIDC provider is told which account is expected, as the sign-in
 * form does for a routed address.
 */
export function signInAgainProviderRequest(
  provider: SignInAgainProvider,
  email: string,
  returnUrl: string
): SignInAgainProviderRequest {
  return {
    providerId: provider.id,
    callbackURL: returnUrl,
    errorCallbackURL: returnUrl,
    ...(provider.type === 'oidc' ? { loginHint: email } : {}),
  }
}
