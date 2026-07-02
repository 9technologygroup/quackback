/**
 * AI-suggestion tools: list, accept, dismiss, and restore feedback + merge
 * suggestions produced by the ingestion pipeline.
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  acceptCreateSuggestion,
  acceptVoteSuggestion,
  dismissSuggestion as dismissFeedbackSuggestion,
  restoreSuggestion as restoreFeedbackSuggestion,
} from '@/lib/server/domains/feedback/pipeline/suggestion.service'
import {
  acceptMergeSuggestion,
  dismissMergeSuggestion,
  restoreMergeSuggestion,
} from '@/lib/server/domains/merge-suggestions/merge-suggestion.service'
import { isTypeId, isValidTypeId } from '@quackback/ids'
import type { FeedbackSuggestionId, PostMergeSuggestionId } from '@quackback/ids'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpAuthContext } from '../types'
import {
  registerTool,
  jsonResult,
  errorResult,
  encodeSearchCursor,
  decodeSearchCursor,
  READ_ONLY,
  WRITE,
} from './helpers'

/**
 * Classify a suggestion TypeID for the accept/dismiss/restore tools, owning
 * the shared invalid-id validation and its error message.
 */
function resolveSuggestionKind(
  id: string
):
  | { kind: 'merge'; id: PostMergeSuggestionId }
  | { kind: 'feedback'; id: FeedbackSuggestionId }
  | { kind: 'invalid'; result: CallToolResult } {
  if (isTypeId(id, 'post_merge_sug')) return { kind: 'merge', id: id as PostMergeSuggestionId }
  if (isValidTypeId(id, 'feedback_suggestion')) {
    return { kind: 'feedback', id: id as FeedbackSuggestionId }
  }
  return {
    kind: 'invalid',
    result: errorResult(
      new Error(
        'Invalid suggestion ID. Expected feedback_suggestion_xxx or post_merge_sug_xxx format.'
      )
    ),
  }
}

// ============================================================================
// Schemas
// ============================================================================

const listSuggestionsSchema = {
  status: z
    .enum(['pending', 'dismissed'])
    .default('pending')
    .describe('Filter by status: pending or dismissed'),
  suggestionType: z
    .enum(['create_post', 'vote_on_post', 'duplicate_post'])
    .optional()
    .describe('Filter by suggestion type'),
  sort: z.enum(['newest', 'relevance']).default('newest').describe('Sort order'),
  limit: z.number().min(1).max(100).default(20).describe('Max results per page'),
  cursor: z.string().optional().describe('Pagination cursor from previous response'),
}

const acceptSuggestionSchema = {
  id: z.string().describe('Suggestion TypeID (feedback_suggestion_xxx or post_merge_sug_xxx)'),
  edits: z
    .object({
      title: z.string().optional(),
      body: z.string().optional(),
      boardId: z.string().optional(),
      statusId: z.string().optional(),
    })
    .optional()
    .describe('Optional edits to apply before accepting (create_post type only)'),
  swapDirection: z.boolean().optional().describe('Swap merge direction (duplicate_post type only)'),
}

const dismissSuggestionSchema = {
  id: z
    .string()
    .describe('Suggestion TypeID to dismiss (feedback_suggestion_xxx or post_merge_sug_xxx)'),
}

const restoreSuggestionSchema = {
  id: z
    .string()
    .describe(
      'Suggestion TypeID to restore from dismissed to pending (feedback_suggestion_xxx or post_merge_sug_xxx)'
    ),
}

// ============================================================================
// Type aliases — manually defined to avoid deep Zod type recursion.
// WARNING: These must stay in sync with the Zod schemas above.
// If you add/remove/rename a field in a schema, update the matching type here.
// ============================================================================

type ListSuggestionsArgs = {
  status: 'pending' | 'dismissed'
  suggestionType?: 'create_post' | 'vote_on_post' | 'duplicate_post'
  sort: 'newest' | 'relevance'
  limit: number
  cursor?: string
}

type AcceptSuggestionArgs = {
  id: string
  edits?: {
    title?: string
    body?: string
    boardId?: string
    statusId?: string
  }
  swapDirection?: boolean
}

type DismissSuggestionArgs = { id: string }

type RestoreSuggestionArgs = { id: string }

// ============================================================================
// Tool registration
// ============================================================================

export function registerSuggestionTools(server: McpServer, auth: McpAuthContext) {
  registerTool<ListSuggestionsArgs>(server, auth, {
    name: 'list_suggestions',
    description: `List AI-generated feedback suggestions. Suggestions are created when feedback is ingested from external sources (Slack, email, etc.) and processed by the AI pipeline.

Types:
- create_post: AI suggests creating a new post from extracted feedback
- vote_on_post: AI suggests adding a vote to an existing similar post
- duplicate_post: AI detected two existing posts that may be duplicates

Examples:
- List pending: list_suggestions()
- Filter by type: list_suggestions({ suggestionType: "create_post" })
- Show dismissed: list_suggestions({ status: "dismissed" })`,
    schema: listSuggestionsSchema,
    annotations: READ_ONLY,
    scope: 'read:feedback',
    teamOnly: true,
    handler: async (args) => {
      const { listSuggestions } = await import('@/lib/server/domains/feedback/suggestion.query')

      const decoded = decodeSearchCursor(args.cursor)
      const offset =
        typeof decoded.value === 'number' ? decoded.value : parseInt(String(decoded.value), 10) || 0

      const result = await listSuggestions({
        status: args.status,
        suggestionType: args.suggestionType,
        sort: args.sort,
        limit: args.limit,
        offset,
      })

      const nextCursor = result.hasMore
        ? encodeSearchCursor('suggestions', offset + args.limit)
        : null

      return jsonResult({
        suggestions: result.items,
        total: result.total,
        countsBySource: result.countsBySource,
        nextCursor,
        hasMore: result.hasMore,
      })
    },
  })

  registerTool<AcceptSuggestionArgs>(server, auth, {
    name: 'accept_suggestion',
    description: `Accept an AI-generated suggestion. Behavior depends on the suggestion type:
- create_post: Creates a new post from the extracted feedback. Optional edits can override the suggested title/body/board.
- vote_on_post: Adds a proxy vote to the matched existing post.
- duplicate_post: Merges the source post into the target post. Use swapDirection to reverse which post is kept.

Examples:
- Accept as-is: accept_suggestion({ id: "feedback_suggestion_01abc..." })
- Accept with edits: accept_suggestion({ id: "feedback_suggestion_01abc...", edits: { title: "Better title" } })
- Accept merge: accept_suggestion({ id: "post_merge_sug_01abc..." })
- Accept merge swapped: accept_suggestion({ id: "post_merge_sug_01abc...", swapDirection: true })`,
    schema: acceptSuggestionSchema,
    annotations: WRITE,
    scope: 'write:feedback',
    teamOnly: true,
    handler: async (args) => {
      const resolved = resolveSuggestionKind(args.id)
      if (resolved.kind === 'invalid') return resolved.result

      if (resolved.kind === 'merge') {
        await acceptMergeSuggestion(resolved.id, auth.principalId, {
          swapDirection: args.swapDirection,
        })
        return jsonResult({ accepted: true, id: args.id })
      }

      const suggestionId = resolved.id

      // Look up suggestion to determine type
      const { db, feedbackSuggestions, eq } = await import('@/lib/server/db')
      const suggestion = await db.query.feedbackSuggestions.findFirst({
        where: eq(feedbackSuggestions.id, suggestionId),
        columns: { id: true, suggestionType: true, status: true },
      })

      if (!suggestion || suggestion.status !== 'pending') {
        return errorResult(new Error('Suggestion not found or already resolved'))
      }

      // vote_on_post with no edits → proxy vote
      if (suggestion.suggestionType === 'vote_on_post' && !args.edits) {
        const result = await acceptVoteSuggestion(suggestionId, auth.principalId)
        return jsonResult({
          accepted: true,
          id: args.id,
          resultPostId: result.resultPostId,
        })
      }

      // create_post or vote_on_post with edits → create post
      const result = await acceptCreateSuggestion(suggestionId, auth.principalId, args.edits)
      return jsonResult({
        accepted: true,
        id: args.id,
        resultPostId: result.resultPostId,
      })
    },
  })

  registerTool<DismissSuggestionArgs>(server, auth, {
    name: 'dismiss_suggestion',
    description: `Dismiss an AI-generated suggestion. The suggestion can be restored later via restore_suggestion.

Examples:
- Dismiss: dismiss_suggestion({ id: "feedback_suggestion_01abc..." })
- Dismiss merge: dismiss_suggestion({ id: "post_merge_sug_01abc..." })`,
    schema: dismissSuggestionSchema,
    annotations: WRITE,
    scope: 'write:feedback',
    teamOnly: true,
    handler: async (args) => {
      const resolved = resolveSuggestionKind(args.id)
      if (resolved.kind === 'invalid') return resolved.result

      if (resolved.kind === 'merge') {
        await dismissMergeSuggestion(resolved.id, auth.principalId)
      } else {
        await dismissFeedbackSuggestion(resolved.id, auth.principalId)
      }
      return jsonResult({ dismissed: true, id: args.id })
    },
  })

  registerTool<RestoreSuggestionArgs>(server, auth, {
    name: 'restore_suggestion',
    description: `Restore a dismissed suggestion back to pending status.

Examples:
- Restore: restore_suggestion({ id: "feedback_suggestion_01abc..." })
- Restore merge: restore_suggestion({ id: "post_merge_sug_01abc..." })`,
    schema: restoreSuggestionSchema,
    annotations: WRITE,
    scope: 'write:feedback',
    teamOnly: true,
    handler: async (args) => {
      const resolved = resolveSuggestionKind(args.id)
      if (resolved.kind === 'invalid') return resolved.result

      if (resolved.kind === 'merge') {
        await restoreMergeSuggestion(resolved.id, auth.principalId)
      } else {
        await restoreFeedbackSuggestion(resolved.id, auth.principalId)
      }
      return jsonResult({ restored: true, id: args.id })
    },
  })
}
