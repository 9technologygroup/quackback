/**
 * The nine principal classes from issue #314, each a fixture the matrix
 * evaluates every surface against.
 *
 * Permissions are resolved through the *real* runtime resolver
 * (`resolveActorPermissions`), so a fixture can never drift from what a live
 * request of that class would actually hold. The fixtures also record channel
 * reachability (a browser session cannot call `/api/v1` without a key; an OAuth
 * token only reaches MCP) so the matrix marks unreachable cells `n/a` rather
 * than pretending every class hits every surface.
 *
 * Two honest collapses are encoded rather than hidden:
 *   - anon / unverified / verified widget all resolve to the *same* (empty)
 *     permission set — they differ only in identity metadata and the end-user
 *     policy layer (audience/segments), which the policy-module tests cover.
 *   - a "scoped" API key holds the *same* authority as a full key today: REST
 *     never consults key scopes, and MCP forces ALL_SCOPES for keys. OAuth is
 *     the only class whose scopes actually constrain it. The matrix pins this
 *     over-grant so the deferred scope-narrowing work shows up as a diff.
 */
import { resolveActorPermissions } from '@/lib/server/policy/permissions'
import type { PermissionKey } from '@/lib/shared/permissions'
import type { Role, PrincipalType } from '@/lib/shared/roles'
import type { McpScope } from '@/lib/server/mcp/types'
import type { Channel } from './resolve'

/**
 * Mirrors `ALL_SCOPES` in mcp/handler.ts (kept local so this stays DB-free).
 * `satisfies` ties it to the canonical `McpScope` union — a scope renamed or
 * removed there becomes a compile error here.
 */
export const ALL_MCP_SCOPES = [
  'read:feedback',
  'write:feedback',
  'write:changelog',
  'read:article',
  'write:article',
  'read:chat',
  'write:chat',
] as const satisfies readonly McpScope[]

export type PrincipalClassId =
  | 'admin'
  | 'member'
  | 'portal_user'
  | 'anon_widget'
  | 'unverified_widget'
  | 'verified_widget'
  | 'scoped_api_key'
  | 'full_api_key'
  | 'oauth_client'

export interface PrincipalClass {
  id: PrincipalClassId
  label: string
  role: Role | null
  principalType: PrincipalType
  authMethod: 'cookie' | 'widget-bearer' | 'api-key' | 'oauth'
  /** Surface channels this class can present credentials to. */
  channels: ReadonlySet<Channel>
  /** Resolved catalogue permissions (server-fn / REST authority). */
  permissions: ReadonlySet<PermissionKey>
  /** A team member (admin | member) — satisfies team-only inline gates. */
  isTeamMember: boolean
  /** Holds a valid principal, so bare (END_USER) requireAuth gates admit it. */
  isAuthenticatedPrincipal: boolean
  /** Effective MCP scopes, or null when the class never reaches MCP. */
  mcpScopes: ReadonlySet<string> | null
  note?: string
}

const perms = (role: Role | null): ReadonlySet<PermissionKey> => resolveActorPermissions(role)

const SESSION_CHANNELS = new Set<Channel>(['server-fn', 'sse'])
const KEY_CHANNELS = new Set<Channel>(['api-route', 'mcp'])

export const PRINCIPAL_CLASSES: PrincipalClass[] = [
  {
    id: 'admin',
    label: 'Admin (Owner preset)',
    role: 'admin',
    principalType: 'user',
    authMethod: 'cookie',
    channels: SESSION_CHANNELS,
    permissions: perms('admin'),
    isTeamMember: true,
    isAuthenticatedPrincipal: true,
    mcpScopes: null,
  },
  {
    id: 'member',
    label: 'Member (Manager preset)',
    role: 'member',
    principalType: 'user',
    authMethod: 'cookie',
    channels: SESSION_CHANNELS,
    permissions: perms('member'),
    isTeamMember: true,
    isAuthenticatedPrincipal: true,
    mcpScopes: null,
  },
  {
    id: 'portal_user',
    label: 'Portal user (signed in)',
    role: 'user',
    principalType: 'user',
    authMethod: 'cookie',
    channels: SESSION_CHANNELS,
    permissions: perms('user'),
    isTeamMember: false,
    isAuthenticatedPrincipal: true,
    mcpScopes: null,
  },
  {
    id: 'anon_widget',
    label: 'Anonymous widget visitor',
    role: 'user',
    principalType: 'anonymous',
    authMethod: 'widget-bearer',
    channels: SESSION_CHANNELS,
    permissions: perms('user'),
    isTeamMember: false,
    isAuthenticatedPrincipal: true,
    mcpScopes: null,
    note: 'Synthetic anonymous principal; authz-identical to the other widget classes.',
  },
  {
    id: 'unverified_widget',
    label: 'Unverified widget visitor',
    role: 'user',
    principalType: 'anonymous',
    authMethod: 'widget-bearer',
    channels: SESSION_CHANNELS,
    permissions: perms('user'),
    isTeamMember: false,
    isAuthenticatedPrincipal: true,
    mcpScopes: null,
    note: 'Identify started, not verified — still an anonymous principal. Differs from anon only in captured identity.',
  },
  {
    id: 'verified_widget',
    label: 'Verified widget visitor',
    role: 'user',
    principalType: 'user',
    authMethod: 'widget-bearer',
    channels: SESSION_CHANNELS,
    permissions: perms('user'),
    isTeamMember: false,
    isAuthenticatedPrincipal: true,
    mcpScopes: null,
    note: 'Verified identity (user principalType). Same permission set as portal_user; audience differences live in the policy layer.',
  },
  {
    id: 'scoped_api_key',
    label: 'Scoped API key (admin-owned)',
    role: 'admin',
    principalType: 'service',
    authMethod: 'api-key',
    channels: KEY_CHANNELS,
    permissions: perms('admin'),
    isTeamMember: true,
    isAuthenticatedPrincipal: false,
    // Declared scope is narrow, but REST ignores key scopes and MCP forces
    // ALL_SCOPES for keys — so the effective scope set is everything. Over-grant.
    mcpScopes: new Set(ALL_MCP_SCOPES),
    note: 'Configured scope is ignored: REST never checks it, MCP forces ALL_SCOPES. Effective reach equals a full key.',
  },
  {
    id: 'full_api_key',
    label: 'Full API key (admin-owned)',
    role: 'admin',
    principalType: 'service',
    authMethod: 'api-key',
    channels: KEY_CHANNELS,
    permissions: perms('admin'),
    isTeamMember: true,
    isAuthenticatedPrincipal: false,
    mcpScopes: new Set(ALL_MCP_SCOPES),
  },
  {
    id: 'oauth_client',
    label: 'OAuth client (member, read-only grant)',
    role: 'member',
    principalType: 'user',
    authMethod: 'oauth',
    channels: new Set<Channel>(['mcp']),
    permissions: perms('member'),
    isTeamMember: true,
    isAuthenticatedPrincipal: true,
    // Unlike an API key, an OAuth token's granted scopes ARE enforced on MCP.
    mcpScopes: new Set(['read:feedback', 'read:article', 'read:chat']),
    note: 'Scopes are enforced for OAuth (contrast with API keys): a read-only grant cannot invoke write tools.',
  },
]

export const PRINCIPAL_CLASS_BY_ID: Record<PrincipalClassId, PrincipalClass> = Object.fromEntries(
  PRINCIPAL_CLASSES.map((c) => [c.id, c])
) as Record<PrincipalClassId, PrincipalClass>
