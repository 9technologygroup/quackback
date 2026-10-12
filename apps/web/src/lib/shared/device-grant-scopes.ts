import {
  API_KEY_SCOPES,
  MCP_FIRST_CONNECT_SCOPES,
  expandWriteGrants,
  type ApiKeyScope,
  type DomainAccessLevels,
  ACCESS_DOMAINS,
  domainAccessLevels,
} from '@/lib/shared/api-key-scopes'
import { MCP_IDENTITY_SCOPES, parseScopeList } from '@/lib/shared/mcp-consent-scopes'

/**
 * What a device sign-in may grant.
 *
 * A device request names its scopes up front, so, unlike the browser flow,
 * there is no step-up: the person can approve what the client asked for or
 * less, never more. These helpers keep that rule in one place for the page
 * (which disables chips above the request) and the server (which narrows to it).
 */

/** The capability scopes a device request is asking for (reads when it names none). */
export function deviceRequestedCapabilities(scope: string | null | undefined): ApiKeyScope[] {
  const asked = parseScopeList(scope ?? '')
  const requested = API_KEY_SCOPES.filter((s) => asked.includes(s))
  if (requested.length === 0 && asked.every((s) => !s.includes(':'))) {
    return [...MCP_FIRST_CONNECT_SCOPES]
  }
  return expandWriteGrants(requested)
}

/** Whether the request asked to stay signed in (a refresh token). */
export function deviceRequestedOfflineAccess(scope: string | null | undefined): boolean {
  return parseScopeList(scope ?? '').includes('offline_access')
}

/** The most a request allows in each domain, in picker terms. */
export function deviceAllowedLevels(scope: string | null | undefined): DomainAccessLevels {
  return domainAccessLevels(deviceRequestedCapabilities(scope))
}

/**
 * The scope string to store on the device code once approved: identity scopes
 * the client asked for, `offline_access` when asked for and kept on, and the
 * chosen capabilities that were asked for. Anything beyond the request is dropped.
 */
export function deviceGrantScope(input: {
  requestedScope: string | null | undefined
  selected: readonly string[]
  offlineAccess: boolean
}): string {
  const asked = new Set(parseScopeList(input.requestedScope ?? ''))
  const allowedCaps = new Set<string>(deviceRequestedCapabilities(input.requestedScope))
  const chosen = new Set<string>(
    expandWriteGrants(input.selected.filter((s) => allowedCaps.has(s)))
  )
  const out: string[] = []
  for (const s of MCP_IDENTITY_SCOPES) if (asked.has(s)) out.push(s)
  if (input.offlineAccess && asked.has('offline_access')) out.push('offline_access')
  for (const s of API_KEY_SCOPES) if (chosen.has(s) && allowedCaps.has(s)) out.push(s)
  return out.join(' ')
}

/** Does this grant carry at least one capability? */
export function deviceGrantHasCapability(scope: string): boolean {
  const held = new Set(parseScopeList(scope))
  return ACCESS_DOMAINS.some(
    (d) => held.has(d.writeScope) || (d.readScope && held.has(d.readScope))
  )
}
