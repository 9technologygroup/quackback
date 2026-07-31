/**
 * Tests for the GitHub import wizard's suggested-mapping helpers.
 */

import { describe, it, expect } from 'vitest'
import { suggestBoardCategory, resolveSuggestedBoardId, mapStatusSlug } from '../issue-mapping'

const board = (name: string, slug = name.toLowerCase().replace(/\s+/g, '-')) => ({
  id: `board_${slug}`,
  slug,
  name,
})

describe('suggestBoardCategory', () => {
  it('classifies bug-labelled issues', () => {
    expect(suggestBoardCategory(['bug'])).toBe('bug')
    expect(suggestBoardCategory(['Bug', 'priority'])).toBe('bug')
  })

  it('classifies feature-labelled issues', () => {
    expect(suggestBoardCategory(['enhancement'])).toBe('feature')
    expect(suggestBoardCategory(['feature request'])).toBe('feature')
  })

  it('recognises prefixed type labels', () => {
    // The convention an exact-match list would miss.
    expect(suggestBoardCategory(['Type: Feature'])).toBe('feature')
    expect(suggestBoardCategory(['Type: Bug'])).toBe('bug')
  })

  it('recognises a GitHub issue type when there are no labels', () => {
    expect(suggestBoardCategory([], 'Feature')).toBe('feature')
    expect(suggestBoardCategory([], 'Bug')).toBe('bug')
  })

  it('combines labels and issue type', () => {
    expect(suggestBoardCategory(['needs-triage'], 'Feature')).toBe('feature')
  })

  it('falls back to other for anything else', () => {
    expect(suggestBoardCategory([])).toBe('other')
    expect(suggestBoardCategory(['question', 'docs'])).toBe('other')
    expect(suggestBoardCategory([], 'Task')).toBe('other')
    expect(suggestBoardCategory([], null)).toBe('other')
  })

  it('prefers bug when an issue carries both signals', () => {
    // A bug tagged with a proposed improvement is still a bug, and misfiling
    // one onto a public feature board is the worse mistake.
    expect(suggestBoardCategory(['enhancement', 'bug'])).toBe('bug')
    expect(suggestBoardCategory(['enhancement'], 'Bug')).toBe('bug')
  })
})

describe('resolveSuggestedBoardId', () => {
  it('returns null when there are no boards', () => {
    expect(resolveSuggestedBoardId('bug', [])).toBeNull()
  })

  it('routes bugs to a bug-ish board', () => {
    const boards = [board('Bug Reports'), board('Feature Requests')]
    expect(resolveSuggestedBoardId('bug', boards)).toBe('board_bug-reports')
  })

  it('routes features to a feature-ish board', () => {
    const boards = [board('Bug Reports'), board('Feature Requests')]
    expect(resolveSuggestedBoardId('feature', boards)).toBe('board_feature-requests')
  })

  it('matches on slug as well as name', () => {
    const boards = [board('Ideas', 'feature-requests'), board('Reports', 'bugs')]
    expect(resolveSuggestedBoardId('bug', boards)).toBe('board_bugs')
    expect(resolveSuggestedBoardId('feature', boards)).toBe('board_feature-requests')
  })

  it('falls back to a general-ish board for unclassifiable issues', () => {
    const boards = [board('Feature Requests'), board('General')]
    expect(resolveSuggestedBoardId('other', boards)).toBe('board_general')
  })

  it('suggests the only board on a single-board install', () => {
    const boards = [board('Ideas')]
    expect(resolveSuggestedBoardId('other', boards)).toBe('board_ideas')
    expect(resolveSuggestedBoardId('bug', boards)).toBe('board_ideas')
  })

  it('returns null rather than guessing when several boards exist and none fit', () => {
    // The regression this guards: with no bug board, a bug used to resolve to
    // boards[0] — alphabetically first — and arrive pre-selected.
    const boards = [board('Engineering'), board('Feature Requests')]
    expect(resolveSuggestedBoardId('bug', boards)).toBeNull()
    expect(resolveSuggestedBoardId('other', boards)).toBeNull()
  })

  it('still routes features once the bug board is gone', () => {
    const boards = [board('Engineering'), board('Feature Requests')]
    expect(resolveSuggestedBoardId('feature', boards)).toBe('board_feature-requests')
  })
})

describe('mapStatusSlug', () => {
  it('maps open issues to open', () => {
    expect(mapStatusSlug('open')).toBe('open')
    expect(mapStatusSlug('open', null)).toBe('open')
  })

  it('maps an explicitly completed close to complete', () => {
    expect(mapStatusSlug('closed', 'completed')).toBe('complete')
  })

  it('maps not_planned to declined', () => {
    expect(mapStatusSlug('closed', 'not_planned')).toBe('declined')
  })

  it('keeps duplicates in closed, since merging handles them', () => {
    expect(mapStatusSlug('closed', 'duplicate')).toBe('closed')
  })

  it('does not treat a missing close reason as shipped', () => {
    // Legacy issues predating state_reason would otherwise land in Complete,
    // which is roadmap-visible.
    expect(mapStatusSlug('closed')).toBe('closed')
    expect(mapStatusSlug('closed', null)).toBe('closed')
    expect(mapStatusSlug('closed', 'reopened')).toBe('closed')
  })
})
