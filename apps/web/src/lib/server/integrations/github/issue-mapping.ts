/**
 * Suggested-mapping helpers for the GitHub import wizard (in-app equivalent of
 * scripts/import/adapters/github/field-map.ts — the import package can't be
 * imported here, so the tiny routing logic is duplicated).
 */

export type BoardCategory = 'bug' | 'feature' | 'other'

/**
 * Classify an issue into a coarse board category from its labels and its
 * GitHub issue type. The caller resolves this to an actual board by
 * fuzzy-matching board name/slug (board slugs vary per install — `bugs` vs
 * `bug-reports` etc.).
 *
 * Matching is by substring rather than exact name, because repositories spell
 * the same idea a dozen ways: `enhancement`, `feature request`,
 * `Type: Feature`, or the org-level Feature issue type. An exact list only ever
 * recognises the conventions its author happened to think of, and the cost of
 * being wrong is a suggestion an admin overrides — not a bad import.
 *
 * Bug wins ties. An issue labelled both is far more likely to be a bug that
 * someone tagged with a proposed improvement than the reverse, and misfiling a
 * bug onto a public feature board is the worse outcome.
 */
export function suggestBoardCategory(labels: string[], issueType?: string | null): BoardCategory {
  const signals = [...labels, issueType ?? ''].filter(Boolean).map((value) => value.toLowerCase())

  if (signals.some((s) => s.includes('bug') || s.includes('defect'))) return 'bug'
  if (signals.some((s) => s.includes('feature') || s.includes('enhancement'))) return 'feature'
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
 * Suggest a status slug from GitHub state, close reason, and board category:
 *   - open                             → open
 *   - closed, completed                → complete
 *   - closed, not_planned              → declined
 *   - closed, no reason, feature       → complete
 *   - closed, no reason, anything else → closed
 *
 * `state_reason` is null on every issue closed before GitHub added the field,
 * which in a legacy backlog is most of them. What that silence means depends on
 * what the issue was: a closed feature request is a feature that shipped, and
 * treating those as Complete is what turns an import of years of history into a
 * visible track record. A closed bug or unclassified issue says nothing of the
 * sort, so it stays in Closed rather than being published to a public roadmap.
 *
 * `duplicate` stays Closed rather than Declined: a duplicate was never judged
 * on its merits, and merging is how Quackback consolidates those.
 */
export function mapStatusSlug(
  state: string,
  stateReason?: string | null,
  category?: BoardCategory
): string {
  if (state === 'open') return 'open'
  if (stateReason === 'completed') return 'complete'
  if (stateReason === 'not_planned') return 'declined'
  if (stateReason === 'duplicate') return 'closed'
  return category === 'feature' ? 'complete' : 'closed'
}
