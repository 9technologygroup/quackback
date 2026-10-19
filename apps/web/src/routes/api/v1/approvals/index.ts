import { createFileRoute } from '@tanstack/react-router'
import { assertApiScope, withApiKeyAuth } from '@/lib/server/domains/api/auth'
import {
  successResponse,
  badRequestResponse,
  handleDomainError,
  parsePaginationParams,
} from '@/lib/server/domains/api/responses'
import { parseOptionalTypeId } from '@/lib/server/domains/api/validation'
import { APPROVAL_STATUSES, type ApprovalStatus } from '@/lib/shared/assistant/approvals'
import type { AssistantPendingActionId } from '@quackback/ids'

export const Route = createFileRoute('/api/v1/approvals/')({
  server: {
    handlers: {
      /**
       * GET /api/v1/approvals: the requests this key follows, newest first,
       * cursor-paginated and optionally narrowed to one status. A key follows
       * what it filed and what its creator could decide with the key's
       * authority. Read-only: people decide in the app.
       */
      GET: async ({ request }) => {
        try {
          const auth = await withApiKeyAuth(request)
          assertApiScope(auth, 'read:settings')

          const url = new URL(request.url)
          const { cursor, limit } = parsePaginationParams(url)
          const status = url.searchParams.get('status') ?? undefined
          if (status !== undefined && !(APPROVAL_STATUSES as readonly string[]).includes(status)) {
            return badRequestResponse(`status must be one of ${APPROVAL_STATUSES.join(', ')}`)
          }
          const after = parseOptionalTypeId<AssistantPendingActionId>(
            cursor,
            'assistant_action',
            'cursor'
          )

          const { approvalFollowerForApiKey, listApprovalsForFollower } =
            await import('@/lib/server/domains/assistant/approvals.follow')
          const follower = await approvalFollowerForApiKey(auth.apiKey)
          const page = await listApprovalsForFollower(follower, {
            status: status as ApprovalStatus | undefined,
            limit,
            cursor: after,
          })
          return successResponse(page.items, {
            pagination: { cursor: page.nextCursor, hasMore: page.hasMore },
          })
        } catch (error) {
          return handleDomainError(error)
        }
      },
    },
  },
})
