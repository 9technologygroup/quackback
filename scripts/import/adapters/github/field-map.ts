/**
 * Field mapping utilities for GitHub → Quackback conversion.
 */

/**
 * Stable synthetic email for a GitHub login, so each reporter maps to a
 * distinct Quackback portal user. Matches the scheme used by the live inbound
 * webhook (reporter-resolver.ts), so records reconcile across both paths.
 */
export function syntheticEmail(login: string): string {
  return `${login}@users.noreply.github.com`
}

/**
 * Route an issue to a board slug from its labels (user's chosen policy):
 *   - `bug`                              → bug-reports
 *   - `enhancement` / `Feature Request`  → feature-requests
 *   - everything else / unlabeled        → general (must be pre-created)
 */
export function routeBoard(labels: string[]): string {
  const lower = labels.map((l) => l.toLowerCase())
  if (lower.includes('bug')) return 'bug-reports'
  if (lower.includes('enhancement') || lower.includes('feature request')) {
    return 'feature-requests'
  }
  return 'general'
}

/**
 * Map a GitHub issue state (+ close reason) to a Quackback status slug.
 *   - open                    → open
 *   - closed, not_planned     → closed
 *   - closed, completed/other → complete
 * Unresolved slugs are ignored by the importer (post keeps the default status).
 */
export function mapStatus(state: string, stateReason?: string | null): string {
  if (state === 'open') return 'open'
  if (stateReason === 'not_planned') return 'closed'
  return 'complete'
}

/** Extract label names from GitHub's label array (objects or bare strings). */
export function labelNames(labels: Array<{ name: string } | string>): string[] {
  return labels.map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean)
}
