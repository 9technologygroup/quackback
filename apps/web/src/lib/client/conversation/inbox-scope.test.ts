import { describe, it, expect } from 'vitest'
import type {
  ConversationTagId,
  SegmentId,
  CompanyId,
  TeamId,
  ConversationViewId,
} from '@quackback/ids'
import { navFromSearch, buildListParams, inboxNavKey, type InboxNavItem } from './inbox-scope'

const tagId = 'conversation_tag_x' as ConversationTagId
const segId = 'segment_y' as SegmentId
const companyId = 'company_z' as CompanyId
const teamId = 'team_t' as TeamId
const viewId = 'conversation_view_v' as ConversationViewId

describe('navFromSearch', () => {
  it('resolves a tag scope', () => {
    expect(navFromSearch({ tag: tagId })).toEqual({ kind: 'tag', tagId })
  })

  it('resolves a segment scope when there is no tag', () => {
    expect(navFromSearch({ segment: segId })).toEqual({ kind: 'segment', segmentId: segId })
  })

  it('prefers tag over segment over view (exclusive precedence)', () => {
    expect(navFromSearch({ tag: tagId, segment: segId, view: 'mine' })).toEqual({
      kind: 'tag',
      tagId,
    })
    expect(navFromSearch({ segment: segId, view: 'mine' })).toEqual({
      kind: 'segment',
      segmentId: segId,
    })
  })

  it('falls back to the view, defaulting to "all"', () => {
    expect(navFromSearch({ view: 'unassigned' })).toEqual({ kind: 'view', view: 'unassigned' })
    expect(navFromSearch({})).toEqual({ kind: 'view', view: 'all' })
  })

  it('resolves team + custom scopes with precedence custom > team > tag', () => {
    expect(navFromSearch({ team: teamId })).toEqual({ kind: 'team', teamId })
    expect(navFromSearch({ viewId })).toEqual({ kind: 'custom', viewId })
    // custom wins over everything; team wins over tag/segment/view.
    expect(navFromSearch({ viewId, team: teamId, tag: tagId })).toEqual({ kind: 'custom', viewId })
    expect(navFromSearch({ team: teamId, tag: tagId, view: 'mine' })).toEqual({
      kind: 'team',
      teamId,
    })
  })
})

describe('inboxNavKey', () => {
  it('namespaces every scope kind so query keys never collide', () => {
    expect(inboxNavKey({ kind: 'view', view: 'all' })).toBe('view:all')
    expect(inboxNavKey({ kind: 'tag', tagId })).toBe(`tag:${tagId}`)
    expect(inboxNavKey({ kind: 'segment', segmentId: segId })).toBe(`segment:${segId}`)
    expect(inboxNavKey({ kind: 'team', teamId })).toBe(`team:${teamId}`)
    expect(inboxNavKey({ kind: 'custom', viewId })).toBe(`custom:${viewId}`)
  })
})

describe('buildListParams', () => {
  const view = (v: 'mine' | 'unassigned' | 'all' | 'mentions'): InboxNavItem => ({
    kind: 'view',
    view: v,
  })

  it('maps a tag scope to tagIds, carrying status/priority/search', () => {
    expect(buildListParams({ kind: 'tag', tagId }, 'open', 'high', 'refund')).toEqual({
      tagIds: [tagId],
      status: 'open',
      priority: 'high',
      search: 'refund',
    })
  })

  it('maps a segment scope to segmentIds', () => {
    expect(buildListParams({ kind: 'segment', segmentId: segId }, 'closed', 'all', '')).toEqual({
      segmentIds: [segId],
      status: 'closed',
      priority: undefined,
      search: undefined,
    })
  })

  it('maps the mentions view to a self-contained feed (no status/priority/assignee)', () => {
    expect(buildListParams(view('mentions'), 'open', 'high', 'hi')).toEqual({
      view: 'mentions',
      search: 'hi',
    })
  })

  it('maps assignee queues, dropping "all" status/priority to undefined', () => {
    expect(buildListParams(view('mine'), 'all', 'all', '')).toEqual({
      status: undefined,
      priority: undefined,
      assignee: 'mine',
      search: undefined,
    })
    expect(buildListParams(view('unassigned'), 'open', 'all', '')).toEqual({
      status: 'open',
      priority: undefined,
      assignee: 'unassigned',
      search: undefined,
    })
    expect(buildListParams(view('all'), 'open', 'all', '')).toEqual({
      status: 'open',
      priority: undefined,
      assignee: 'all',
      search: undefined,
    })
  })

  it('carries the optional company refinement across scopes', () => {
    expect(buildListParams(view('all'), 'open', 'all', '', companyId)).toMatchObject({
      assignee: 'all',
      companyId,
    })
    expect(buildListParams({ kind: 'tag', tagId }, 'open', 'all', '', companyId)).toMatchObject({
      tagIds: [tagId],
      companyId,
    })
  })

  it('carries a non-default sort but omits the implicit "recent" default', () => {
    expect(buildListParams(view('all'), 'open', 'all', '', undefined, 'waiting')).toMatchObject({
      assignee: 'all',
      sort: 'waiting',
    })
    // 'recent' is the server default, so it is dropped to keep params stable.
    expect(
      buildListParams(view('all'), 'open', 'all', '', undefined, 'recent').sort
    ).toBeUndefined()
  })

  it('maps a team scope to a teamId filter', () => {
    expect(buildListParams({ kind: 'team', teamId }, 'open', 'high', 'bug')).toMatchObject({
      teamId,
      status: 'open',
      priority: 'high',
      search: 'bug',
    })
  })

  it('runs a custom view from its pre-translated params (chips ignored)', () => {
    const customParams = {
      status: 'closed' as const,
      waitingOnly: true,
      tagIds: ['conversation_tag_x'],
    }
    // Even though status='open'/priority='high' chips are passed, a custom scope
    // uses ONLY its own rule set (plus search/company/sort).
    expect(
      buildListParams(
        { kind: 'custom', viewId },
        'open',
        'high',
        'refund',
        companyId,
        'oldest',
        customParams
      )
    ).toEqual({
      status: 'closed',
      waitingOnly: true,
      tagIds: ['conversation_tag_x'],
      search: 'refund',
      companyId,
      sort: 'oldest',
    })
  })
})
