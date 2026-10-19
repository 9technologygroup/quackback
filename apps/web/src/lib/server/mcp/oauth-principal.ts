/**
 * The one database read an OAuth MCP request makes after its token verifies.
 *
 * It re-reads the principal's current role, so a demotion takes effect before
 * the token expires, and carries the OAuth client's registered name along in
 * the same statement for audit attribution, so naming the client costs no
 * extra round-trip.
 */
import { db, principal, eq, sql } from '@/lib/server/db'
import type { PrincipalId } from '@quackback/ids'

export interface OAuthPrincipalRead {
  role: string
  /** The OAuth client's registered name, or null when it has none or is gone. */
  clientName: string | null
}

/** Null when the principal no longer exists. */
export async function readOAuthPrincipal(
  principalId: PrincipalId,
  clientId: string | null
): Promise<OAuthPrincipalRead | null> {
  const row = await db.query.principal.findFirst({
    where: eq(principal.id, principalId),
    columns: { role: true },
    extras: {
      clientName: (clientId
        ? sql<
            string | null
          >`(select oc."name" from "oauth_client" oc where oc."client_id" = ${clientId} limit 1)`
        : sql<string | null>`null::text`
      ).as('client_name'),
    },
  })
  if (!row) return null
  return { role: row.role, clientName: (row as { clientName?: string | null }).clientName ?? null }
}
