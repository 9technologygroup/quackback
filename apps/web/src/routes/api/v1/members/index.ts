import { createFileRoute } from '@tanstack/react-router'
import { listPrincipalsHandlers } from '../principals/index'

/**
 * Deprecated alias of /api/v1/principals. Serves the same handlers so clients
 * written against the old path keep working.
 */
export const Route = createFileRoute('/api/v1/members/')({
  server: { handlers: listPrincipalsHandlers },
})
