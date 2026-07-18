/**
 * Shared role/seat visual tokens for the members area, so the "custom role"
 * amber treatment (and the invited/plan-cap variants) read identically across
 * the members table, roles tab, role editor, and invite dialog.
 */

/** Custom-role chip + accent (amber). One recipe, reused everywhere. */
export const CUSTOM_ROLE_BADGE =
  'border-amber-300/60 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'

/** Amber notice surface (plan-cap banner, custom-role callouts). */
export const CUSTOM_ROLE_NOTICE =
  'border-amber-300/50 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200'
