/**
 * Global request middleware: the request boundary for audit attribution.
 *
 * A server function is the signed-in app, so its changes are attributed to the
 * `ui` channel. Every other request opens an empty slot instead: REST key auth
 * runs inside the route handler and fills it with the key (see
 * domains/api/auth.ts), and the MCP handler and the assistant open their own
 * nested boundaries. Requests nothing attributes leave the columns null.
 *
 * A REST write the key made is recorded here once, as `api.write`, after the
 * route answers (see audit/api-write.ts). Reads are never recorded.
 *
 * Runs after workspace resolution so that anything recorded here lands in the
 * request's own workspace database.
 */
import { createMiddleware } from '@tanstack/react-start'

// Loaded on first use: the start entry is part of the client build, and the
// boundary reaches the database.
export const auditAttributionMiddleware = createMiddleware().server(
  async ({ next, request, handlerType }) => {
    const { handleRequestWithAuditAttribution } =
      await import('@/lib/server/audit/request-boundary')
    return handleRequestWithAuditAttribution({
      request,
      handlerType,
      next: () => Promise.resolve(next()),
    })
  }
)
