/**
 * Resolve a GitHub issue reporter to a Quackback principal.
 *
 * Two tiers, in order of fidelity:
 *   1. Real user — if the reporter has signed into Quackback via GitHub OAuth,
 *      an `account` row (providerId='github', accountId=<github user id>) points
 *      at their user; attribute the post to that user's principal.
 *   2. Synthetic user — otherwise create/return a portal user keyed by a stable
 *      GitHub noreply email, so each GitHub login maps to a distinct principal.
 *
 * The synthetic email scheme (`<login>@users.noreply.github.com`) is identical
 * to the one used by the one-time REST migration, so a reporter who later signs
 * in with GitHub can be reconciled with their synthetic user afterwards.
 */

import { db, account, principal, eq, and } from '@/lib/server/db'
import type { PrincipalId } from '@quackback/ids'
import { identifyPortalUser } from '@/lib/server/domains/users/user.identify'

export interface GitHubReporter {
  /** GitHub numeric user id (issue.user.id). */
  githubId: number | string | null
  /** GitHub login handle (issue.user.login). */
  login: string
  /** Display name, if present on the payload. */
  name?: string | null
}

/**
 * Resolve a GitHub reporter to a principal id, creating a synthetic portal user
 * when no real GitHub-linked account exists.
 */
export async function resolveGitHubReporterPrincipal(
  reporter: GitHubReporter
): Promise<PrincipalId> {
  // 1. Real user — only if they've previously signed in with GitHub.
  if (reporter.githubId != null) {
    const linked = await db.query.account.findFirst({
      where: and(eq(account.providerId, 'github'), eq(account.accountId, String(reporter.githubId))),
      columns: { userId: true },
    })
    if (linked?.userId) {
      const linkedPrincipal = await db.query.principal.findFirst({
        where: eq(principal.userId, linked.userId),
        columns: { id: true },
      })
      if (linkedPrincipal) {
        return linkedPrincipal.id as PrincipalId
      }
    }
  }

  // 2. Synthetic per-login portal user.
  const identified = await identifyPortalUser({
    email: `${reporter.login}@users.noreply.github.com`,
    name: reporter.name || reporter.login,
  })
  return identified.principalId
}
