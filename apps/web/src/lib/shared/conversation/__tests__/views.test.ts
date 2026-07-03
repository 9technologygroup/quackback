import { describe, it, expect } from 'vitest'
import {
  conversationViewFiltersSchema,
  viewFiltersToListParams,
  isConversationSort,
  MAX_VIEW_RULES,
  CONVERSATION_SORTS,
  type ConversationViewFilters,
} from '../views'

describe('conversationViewFiltersSchema', () => {
  it('accepts a valid rule set', () => {
    const filters = {
      rules: [
        { field: 'status', value: 'open' },
        { field: 'priority', value: 'high' },
        { field: 'assignee', value: 'me' },
        { field: 'waiting', value: true },
        { field: 'tag', value: 'conversation_tag_1' },
      ],
    }
    expect(conversationViewFiltersSchema.safeParse(filters).success).toBe(true)
  })

  it('rejects an unknown status value', () => {
    const r = conversationViewFiltersSchema.safeParse({
      rules: [{ field: 'status', value: 'archived' }],
    })
    expect(r.success).toBe(false)
  })

  it('rejects a waiting rule whose value is not literally true', () => {
    expect(
      conversationViewFiltersSchema.safeParse({ rules: [{ field: 'waiting', value: false }] })
        .success
    ).toBe(false)
  })

  it(`caps the rule set at ${MAX_VIEW_RULES} rules`, () => {
    const overCap = {
      rules: Array.from({ length: MAX_VIEW_RULES + 1 }, () => ({ field: 'status', value: 'open' })),
    }
    expect(conversationViewFiltersSchema.safeParse(overCap).success).toBe(false)
    const atCap = {
      rules: Array.from({ length: MAX_VIEW_RULES }, () => ({ field: 'status', value: 'open' })),
    }
    expect(conversationViewFiltersSchema.safeParse(atCap).success).toBe(true)
  })
})

describe('viewFiltersToListParams', () => {
  it('translates each rule field to its list-query param', () => {
    const filters: ConversationViewFilters = {
      rules: [
        { field: 'status', value: 'closed' },
        { field: 'priority', value: 'urgent' },
        { field: 'assignee', value: 'unassigned' },
        { field: 'team', value: 'team_1' },
        { field: 'source', value: 'email' },
        { field: 'waiting', value: true },
      ],
    }
    expect(viewFiltersToListParams(filters)).toEqual({
      status: 'closed',
      priority: 'urgent',
      assignee: 'unassigned',
      teamId: 'team_1',
      source: 'email',
      waitingOnly: true,
    })
  })

  it('collects repeated tag rules into an OR-semantics tagIds array', () => {
    const filters: ConversationViewFilters = {
      rules: [
        { field: 'tag', value: 'conversation_tag_a' },
        { field: 'tag', value: 'conversation_tag_b' },
      ],
    }
    expect(viewFiltersToListParams(filters)).toEqual({
      tagIds: ['conversation_tag_a', 'conversation_tag_b'],
    })
  })

  it('returns empty params for an empty rule set', () => {
    expect(viewFiltersToListParams({ rules: [] })).toEqual({})
  })

  it('normalizes the assignee "me" token to the server-resolved "mine"', () => {
    expect(viewFiltersToListParams({ rules: [{ field: 'assignee', value: 'me' }] })).toEqual({
      assignee: 'mine',
    })
  })

  // The view dialog emits a fixed set of assignee tokens; listConversationsFn
  // only resolves 'mine'/'unassigned'/'all'/a principal id, silently matching
  // everything for anything else. Guard that every token the dialog can save
  // translates into one the server actually honors.
  it('translates every dialog assignee token into a server-resolvable one', () => {
    const DIALOG_ASSIGNEE_TOKENS = ['me', 'unassigned'] as const
    const SERVER_RESOLVABLE = new Set(['all', 'mine', 'unassigned'])
    for (const token of DIALOG_ASSIGNEE_TOKENS) {
      const { assignee } = viewFiltersToListParams({
        rules: [{ field: 'assignee', value: token }],
      })
      expect(assignee && SERVER_RESOLVABLE.has(assignee)).toBe(true)
    }
  })
})

describe('isConversationSort', () => {
  it('accepts every canonical sort', () => {
    for (const s of CONVERSATION_SORTS) expect(isConversationSort(s)).toBe(true)
  })
  it('rejects unknown / non-string values', () => {
    expect(isConversationSort('breach')).toBe(false)
    expect(isConversationSort(undefined)).toBe(false)
    expect(isConversationSort(3)).toBe(false)
  })
})
