import { createFileRoute } from '@tanstack/react-router'
import { withApiKeyAuth } from '@/lib/server/domains/api/auth'
import { handleDomainError } from '@/lib/server/domains/api/responses'
import {
  assertSettingsScope,
  settingsCallerFromApiAuth,
  undoResponse,
} from '@/lib/server/domains/settings-registry/http'

export const Route = createFileRoute('/api/v1/settings/receipts/$receiptId/undo')({
  server: {
    handlers: {
      /**
       * POST /api/v1/settings/receipts/:receiptId/undo
       * Restore what a receipt recorded, while the values have not moved
       */
      POST: async ({ request, params }) => {
        try {
          const auth = await withApiKeyAuth(request)
          assertSettingsScope(auth, 'write:settings')
          const { undoSettingsReceipt } =
            await import('@/lib/server/domains/settings-registry/undo')
          return undoResponse(
            await undoSettingsReceipt(settingsCallerFromApiAuth(auth), params.receiptId)
          )
        } catch (error) {
          return handleDomainError(error)
        }
      },
    },
  },
})
