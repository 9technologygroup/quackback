/**
 * Custom saved inbox views (support platform §4.6): the client-safe rule model,
 * its zod validation, and the rules→list-filter translation.
 *
 * A view is a saved filter SET, not a server-side query: running it means
 * translating its rules into the ordinary conversation-list params on the
 * client and reusing the same query factory. This module is the single source
 * of truth for the shape — the widget/portal/admin bundles and the server
 * domain all import it (the server can import shared; the client can't import
 * @quackback/db). Zod caps a view at 15 rules per the spec.
 */
import { z } from 'zod'
import type { ConversationViewId } from '@quackback/ids'
import type { ConversationStatus, ConversationPriority } from './types'

// ── Sorts ──────────────────────────────────────────────────────────────────

/** The inbox sorts. 'recent' (last activity, newest first) is the default. */
export const CONVERSATION_SORTS = [
  'recent',
  'oldest',
  'created',
  'waiting',
  'priority',
  'sla',
] as const
export type ConversationSort = (typeof CONVERSATION_SORTS)[number]
export const DEFAULT_CONVERSATION_SORT: ConversationSort = 'recent'

export function isConversationSort(v: unknown): v is ConversationSort {
  return typeof v === 'string' && (CONVERSATION_SORTS as readonly string[]).includes(v)
}

/** English labels for the sort picker (no locale catalogue yet; see report). */
export const CONVERSATION_SORT_LABELS: Record<ConversationSort, string> = {
  recent: 'Most recent',
  oldest: 'Oldest',
  created: 'Recently created',
  waiting: 'Waiting longest',
  priority: 'Priority',
  sla: 'SLA breach soonest',
}

// ── Rules ────────────────────────────────────────────────────────────────────

export const MAX_VIEW_RULES = 15

/** The rule fields a saved view can filter on (the ones the list query honors). */
export const CONVERSATION_VIEW_RULE_FIELDS = [
  'status',
  'priority',
  'assignee',
  'team',
  'tag',
  'source',
  'waiting',
] as const
export type ConversationViewRuleField = (typeof CONVERSATION_VIEW_RULE_FIELDS)[number]

// A discriminated union keeps each rule's value shape honest. `assignee` is
// 'me' | 'unassigned' | a teammate principal id; `team`/`tag` carry an id;
// `waiting` is a presence flag (only "waiting" makes sense as a saved rule).
export const conversationViewRuleSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('status'), value: z.enum(['open', 'snoozed', 'closed']) }),
  z.object({
    field: z.literal('priority'),
    value: z.enum(['none', 'low', 'medium', 'high', 'urgent']),
  }),
  z.object({ field: z.literal('assignee'), value: z.string().min(1).max(64) }),
  z.object({ field: z.literal('team'), value: z.string().min(1).max(64) }),
  z.object({ field: z.literal('tag'), value: z.string().min(1).max(64) }),
  z.object({ field: z.literal('source'), value: z.string().min(1).max(32) }),
  z.object({ field: z.literal('waiting'), value: z.literal(true) }),
])
export type ConversationViewRule = z.infer<typeof conversationViewRuleSchema>

export const conversationViewFiltersSchema = z.object({
  rules: z.array(conversationViewRuleSchema).max(MAX_VIEW_RULES),
})
export type ConversationViewFilters = z.infer<typeof conversationViewFiltersSchema>

/** A saved view as the inbox nav + dialog consume it (per-viewer `isPinned`). */
export interface ConversationViewDTO {
  id: ConversationViewId
  name: string
  filters: ConversationViewFilters
  sort: ConversationSort | null
  isShared: boolean
  isPinned: boolean
}

// ── Translation ──────────────────────────────────────────────────────────────

/**
 * The subset of the conversation-list params a view can drive. Mirrors the
 * fields `listConversationsFn` accepts; sort + search + company ride alongside
 * from the URL, not the view.
 */
export interface ConversationViewListParams {
  status?: ConversationStatus
  priority?: ConversationPriority
  /** 'me' | 'unassigned' | a teammate principal id. */
  assignee?: string
  teamId?: string
  tagIds?: string[]
  source?: string
  waitingOnly?: boolean
}

/**
 * Translate a view's saved rules into list-query params (client-side). Rules
 * combine with AND; repeated `tag` rules collect into the OR-semantics tagIds
 * array (matching the inbox tag filter). Later rules win for single-valued
 * fields. Custom-attribute rules are intentionally absent until the
 * conversation.set_attributes query capability lands (see report).
 */
export function viewFiltersToListParams(
  filters: ConversationViewFilters
): ConversationViewListParams {
  const params: ConversationViewListParams = {}
  const tagIds: string[] = []
  for (const rule of filters.rules) {
    switch (rule.field) {
      case 'status':
        params.status = rule.value
        break
      case 'priority':
        params.priority = rule.value
        break
      case 'assignee':
        // The dialog emits 'me' for the current viewer; the server list fn
        // resolves 'mine'. Normalize so an "Assignee = Me" view scopes to self
        // rather than matching every conversation. 'unassigned' and any
        // teammate principal id pass through unchanged.
        params.assignee = rule.value === 'me' ? 'mine' : rule.value
        break
      case 'team':
        params.teamId = rule.value
        break
      case 'tag':
        tagIds.push(rule.value)
        break
      case 'source':
        params.source = rule.value
        break
      case 'waiting':
        params.waitingOnly = true
        break
    }
  }
  if (tagIds.length > 0) params.tagIds = tagIds
  return params
}
