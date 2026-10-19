import { createFileRoute } from '@tanstack/react-router'
import { principalHandlers } from '../principals/$principalId'

/**
 * Deprecated alias of /api/v1/principals/$principalId. Serves the same
 * handlers so clients written against the old path keep working.
 */
export const Route = createFileRoute('/api/v1/members/$principalId')({
  server: { handlers: principalHandlers },
})
