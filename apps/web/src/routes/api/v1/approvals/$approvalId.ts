import { createFileRoute } from '@tanstack/react-router'
import { assertApiScope, withApiKeyAuth } from '@/lib/server/domains/api/auth'
import { successResponse, handleDomainError } from '@/lib/server/domains/api/responses'
import { parseTypeId } from '@/lib/server/domains/api/validation'
import type { AssistantPendingActionId } from '@quackback/ids'

export const Route = createFileRoute('/api/v1/approvals/$approvalId')({
  server: {
    handlers: {
      /**
       * GET /api/v1/approvals/:approvalId: where one request stands. A key
       * reads what it filed and what its creator could decide with the key's
       * authority; anything else is a 404, the same as an id that does not
       * exist. Read-only: a person decides in the app, at the returned url.
       */
      GET: async ({ request, params }) => {
        try {
          const auth = await withApiKeyAuth(request)
          assertApiScope(auth, 'read:settings')
          const approvalId = parseTypeId<AssistantPendingActionId>(
            params.approvalId,
            'assistant_action',
            'approval ID'
          )
          const { approvalFollowerForApiKey, getApprovalForFollower } =
            await import('@/lib/server/domains/assistant/approvals.follow')
          const follower = await approvalFollowerForApiKey(auth.apiKey)
          return successResponse(await getApprovalForFollower(follower, approvalId))
        } catch (error) {
          return handleDomainError(error)
        }
      },
    },
  },
})
