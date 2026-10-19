/**
 * Did this person sign in recently?
 *
 * Answered from the moment the current session was created, because a session
 * is only ever created by a sign-in: password, emailed code or link, an
 * identity provider, or a recovery code. A session refresh moves `updatedAt`
 * and the expiry forward and never `createdAt`, so a session that is old but
 * still in use stays an old sign-in.
 *
 * Better Auth has the same notion (`session.freshAge`, enforced by its
 * `freshSessionMiddleware` on its own endpoints) and measures it the same way,
 * from `session.createdAt`. It is not used here: that middleware only runs
 * inside Better Auth endpoints, while sensitive decisions are server
 * functions; and `freshAge` is one setting shared by Better Auth's own
 * endpoints (listing sessions, unlinking an account, deleting a user), so
 * shortening it to this window would change them too.
 *
 * Only a dashboard session of a person counts. Widget and portal sessions are
 * minted by the app (an identified widget visitor, an anonymous visitor)
 * rather than by anyone signing in here.
 */
import type { UserId } from '@quackback/ids'
import { getRequestSession } from '@/lib/server/auth/request-session'
import { RECENT_SIGN_IN_WINDOW_MS, RecentSignInRequiredError } from '@/lib/shared/recent-sign-in'
import { toSessionScope } from '@/lib/shared/roles'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'recent-sign-in' })

/** Clock difference tolerated between the server that wrote the session and this one. */
const CLOCK_SKEW_MS = 60 * 1000

/** The parts of a resolved session the answer depends on. */
export interface SignInSession {
  session: { createdAt: Date | string; scope?: unknown; userId?: string }
  user: { id?: string; isAnonymous?: boolean | null }
}

/** The caller the check is for, when it has already authorised one. */
export interface RecentSignInCaller {
  user: { id: UserId | string }
}

/** Whether this session was created by a person signing in within the window. */
export function isRecentSignIn(
  resolved: SignInSession | null | undefined,
  now: number = Date.now()
): boolean {
  if (!resolved?.session) return false
  if (toSessionScope(resolved.session.scope) !== 'dashboard') return false
  if (resolved.user?.isAnonymous === true) return false
  const createdAt = new Date(resolved.session.createdAt).getTime()
  if (Number.isNaN(createdAt)) return false
  const age = now - createdAt
  return age > -CLOCK_SKEW_MS && age < RECENT_SIGN_IN_WINDOW_MS
}

/**
 * Whether the person behind this request signed in recently. Pass the
 * authorised caller to also require that the session is theirs.
 */
export async function hasRecentSignIn(caller?: RecentSignInCaller): Promise<boolean> {
  const resolved = await getRequestSession()
  if (!resolved) return false
  if (caller && resolved.user.id !== caller.user.id) return false
  return isRecentSignIn(resolved)
}

/**
 * Call before a sensitive decision. Throws `RecentSignInRequiredError` unless
 * the person signed in within the window; the server function turns that into
 * the refusal value the client acts on (`toRecentSignInRefusal`).
 */
export async function requireRecentSignIn(caller?: RecentSignInCaller): Promise<void> {
  if (await hasRecentSignIn(caller)) return
  log.info({ user_id: caller?.user.id }, 'recent sign-in required')
  throw new RecentSignInRequiredError()
}
