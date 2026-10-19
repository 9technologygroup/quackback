/**
 * Whether the team controls a principal's display name today. Names are read
 * live, so a teammate removed from the team (role 'user') can rename themselves
 * on the portal, and every row they wrote while on the team then shows that
 * name. Callers use this to decide whether a name is the team's own text.
 */
import { db, principal, inArray } from '@/lib/server/db'
import type { PrincipalId } from '@quackback/ids'
import { isTeamMember } from '@/lib/shared/roles'

/**
 * An admin or member (support staff included), or a service principal
 * (integrations, API keys, the assistant), whose name the team or this app
 * sets. Portal users, visitors and former teammates choose their own.
 */
export function isOnTeam(row: { type: string | null; role: string | null }): boolean {
  return row.type === 'service' || isTeamMember(row.role)
}

/** The ids among `ids` whose principals are on the team today, from one read (none for no ids). */
export async function principalIdsOnTeam(
  ids: ReadonlyArray<string | null | undefined>
): Promise<Set<string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))]
  if (unique.length === 0) return new Set()
  const rows = await db
    .select({ id: principal.id, type: principal.type, role: principal.role })
    .from(principal)
    .where(inArray(principal.id, unique as PrincipalId[]))
  return new Set(rows.filter(isOnTeam).map((row) => row.id))
}
