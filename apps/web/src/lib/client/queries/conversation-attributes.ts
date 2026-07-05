/**
 * Query-options factory for conversation attribute definitions — shared by the
 * settings page (full registry incl. archived), the inbox panel editor, and
 * the macro/workflow definition pickers (live definitions only).
 */
import { queryOptions } from '@tanstack/react-query'
import { listConversationAttributesFn } from '@/lib/server/functions/conversation-attributes'

export type ConversationAttributeItem = Awaited<
  ReturnType<typeof listConversationAttributesFn>
>[number]

export const conversationAttributeQueries = {
  /** Live (non-archived) definitions, for pickers + the inbox editor. */
  live: () =>
    queryOptions({
      queryKey: ['admin', 'conversation-attributes', 'live'],
      queryFn: () => listConversationAttributesFn(),
      staleTime: 60_000,
    }),
  /** The full registry (archived included), for the settings page. */
  registry: () =>
    queryOptions({
      queryKey: ['admin', 'conversation-attributes', 'registry'],
      queryFn: () => listConversationAttributesFn({ data: { includeArchived: true } }),
    }),
}
