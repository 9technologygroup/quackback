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
 * Resolve a category to a board id by fuzzy-matching the available boards.
 *
 * Returns null when no board is a plausible home and the destination would be a
 * guess. The wizard leaves such rows unchecked (it seeds `include` from
 * `!!suggestedBoardId`), so an unclassifiable issue waits for a human instead of
 * landing somewhere arbitrary. That matters because the arbitrary choice used to
 * be `boards[0]`, which is alphabetical — on a two-board install a bug report
 * could be pre-selected into whichever board happens to sort first.
 *
 * A single-board install is the exception: there is only one destination, so
 * there is nothing to get wrong and every row stays importable out of the box.
 */
export function resolveSuggestedBoardId(
  category: BoardCategory,
  boards: Array<{ id: string; slug: string; name: string }>
): string | null {
  if (boards.length === 0) return null
  const matches = (patterns: RegExp) =>
    boards.find((b) => patterns.test(b.slug) || patterns.test(b.name))
  if (category === 'bug') {
    const b = matches(/bug|defect|issue/i)
    if (b) return b.id
  }
  if (category === 'feature') {
    const b = matches(/feature|feedback|request|enhancement|idea/i)
    if (b) return b.id
  }
  const general = matches(/general|feedback|other/i)
  if (general) return general.id
  return boards.length === 1 ? boards[0].id : null
}

/**
 * Suggest a status slug from GitHub state (+ close reason):
 *   - open                        → open
 *   - closed, completed           → complete
 *   - closed, not_planned         → declined
 *   - closed, anything else/null  → closed
 *
 * Only an explicit `completed` reason maps to `complete`, because Complete is
 * roadmap-visible by default. `state_reason` is null on every issue closed
 * before GitHub added the field, which in a legacy backlog is most of them —
 * treating that silence as "shipped" would publish hundreds of old issues to a
 * public roadmap on import. Landing them in Closed instead makes putting
 * something on the roadmap a deliberate act.
 *
 * `duplicate` stays Closed rather than Declined: a duplicate was never judged
 * on its merits, and merging is how Quackback consolidates those.
 */
export function mapStatusSlug(state: string, stateReason?: string | null): string {
  if (state === 'open') return 'open'
  if (stateReason === 'completed') return 'complete'
  if (stateReason === 'not_planned') return 'declined'
  return 'closed'
}
