import { createFileRoute } from '@tanstack/react-router'
import { withApiKeyAuth } from '@/lib/server/domains/api/auth'
import {
  successResponse,
  badRequestResponse,
  handleDomainError,
} from '@/lib/server/domains/api/responses'
import { isTypeId, isValidTypeId } from '@quackback/ids'
import { PERMISSIONS } from '@/lib/shared/permissions'
import type { FeedbackSuggestionId, PostMergeSuggestionId } from '@quackback/ids'

export const Route = createFileRoute('/api/v1/suggestions/$suggestionId/restore')({
  server: {
    handlers: {
      /**
       * POST /api/v1/suggestions/:suggestionId/restore
       * Restore a dismissed suggestion back to pending
       */
      POST: async ({ request, params }) => {
        try {
          const { principalId } = await withApiKeyAuth(request, {
            permission: PERMISSIONS.SUGGESTION_MANAGE,
          })
          const { suggestionId } = params

          // Validate suggestion ID format
          if (
            !isValidTypeId(suggestionId, 'feedback_suggestion') &&
            !isValidTypeId(suggestionId, 'post_merge_sug')
          ) {
            return badRequestResponse(
              'Invalid suggestion ID format. Expected feedback_suggestion_xxx or post_merge_sug_xxx'
            )
          }

          if (isTypeId(suggestionId, 'post_merge_sug')) {
            const { restoreMergeSuggestion } =
              await import('@/lib/server/domains/merge-suggestions/merge-suggestion.service')
            await restoreMergeSuggestion(suggestionId as PostMergeSuggestionId, principalId)
            return successResponse({ restored: true, id: suggestionId })
          }

          const { restoreSuggestion } =
            await import('@/lib/server/domains/feedback/pipeline/suggestion.service')
          await restoreSuggestion(suggestionId as FeedbackSuggestionId, principalId)
          return successResponse({ restored: true, id: suggestionId })
        } catch (error) {
          return handleDomainError(error)
        }
      },
    },
  },
})
