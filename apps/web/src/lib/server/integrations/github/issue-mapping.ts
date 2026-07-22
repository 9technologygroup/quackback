/**
 * Suggested-mapping helpers for the GitHub import wizard (in-app equivalent of
 * scripts/import/adapters/github/field-map.ts — the import package can't be
 * imported here, so the tiny routing logic is duplicated).
 */

export type BoardCategory = 'bug' | 'feature' | 'other'

/**
 * Classify an issue by its labels into a coarse board category. The caller
 * resolves this to an actual board by fuzzy-matching board name/slug (board
 * slugs vary per install — `bugs` vs `bug-reports` etc.), with a fallback so
 * every row is importable out of the box.
 */
export function suggestBoardCategory(labels: string[]): BoardCategory {
  const lower = labels.map((l) => l.toLowerCase())
  if (lower.includes('bug')) return 'bug'
  if (lower.includes('enhancement') || lower.includes('feature request')) return 'feature'
  return 'other'
}

/**
 * Resolve a category to a board id by fuzzy-matching the available boards, with
 * a fallback to the first board so a suggestion is always offered.
 */
export function resolveSuggestedBoardId(
  category: BoardCategory,
  boards: Array<{ id: string; slug: string; name: string }>
): string | null {
  if (boards.length === 0) return null
  const matches = (patterns: RegExp) =>
    boards.find((b) => patterns.test(b.slug) || patterns.test(b.name))
  if (category === 'bug') {
    const b = matches(/bug/i)
    if (b) return b.id
  }
  if (category === 'feature') {
    const b = matches(/feature|feedback|request|enhancement/i)
    if (b) return b.id
  }
  // Fallback: a "general"-ish board if one exists, else the first board.
  return (matches(/general|feedback|other/i)?.id ?? boards[0].id) as string
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
