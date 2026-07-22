/**
 * Suggested-mapping helpers for the GitHub import wizard (in-app equivalent of
 * scripts/import/adapters/github/field-map.ts — the import package can't be
 * imported here, so the tiny routing logic is duplicated).
 */

/**
 * Suggest a board slug from an issue's labels:
 *   - `bug`                              → bug-reports
 *   - `enhancement` / `Feature Request`  → feature-requests
 *   - everything else / unlabeled        → general
 */
export function routeBoardSlug(labels: string[]): string {
  const lower = labels.map((l) => l.toLowerCase())
  if (lower.includes('bug')) return 'bug-reports'
  if (lower.includes('enhancement') || lower.includes('feature request')) {
    return 'feature-requests'
  }
  return 'general'
}

/**
 * Suggest a status slug from GitHub state (+ close reason):
 *   - open                        → open
 *   - closed, not_planned/dup     → closed
 *   - closed, completed/other     → complete
 */
export function mapStatusSlug(state: string, stateReason?: string | null): string {
  if (state === 'open') return 'open'
  if (stateReason === 'not_planned' || stateReason === 'duplicate') return 'closed'
  return 'complete'
}
