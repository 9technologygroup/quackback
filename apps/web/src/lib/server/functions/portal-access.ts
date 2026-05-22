/**
 * Admin server function: update portal access settings (visibility, allowed domains).
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { ForbiddenError } from '@/lib/shared/errors'
import { isAdmin } from '@/lib/shared/roles'
import { requireAuth } from './auth-helpers'
import { getPortalConfig, updatePortalConfig } from '@/lib/server/domains/settings/settings.service'
import { actorFromAuth, recordAuditEvent } from '@/lib/server/audit/log'

// ---------------------------------------------------------------------------
// Domain normalization helpers
// ---------------------------------------------------------------------------

/**
 * Normalizes a single domain string:
 *  - trims whitespace
 *  - lowercases
 *  - strips a leading `@` (e.g. "@acme.com" → "acme.com")
 *
 * Returns `null` when the entry is obviously invalid (no dot, contains `@`
 * after stripping the leading one, contains whitespace, or has a protocol).
 */
function normalizeDomain(raw: string): string | null {
  let d = raw.trim().toLowerCase()
  if (d.startsWith('@')) d = d.slice(1)

  // Reject protocols
  if (d.includes('://')) return null
  // Must not contain @ (e.g. full email address passed by mistake)
  if (d.includes('@')) return null
  // Must not contain whitespace
  if (/\s/.test(d)) return null
  // Must have at least one dot (otherwise it's not a valid domain)
  if (!d.includes('.')) return null

  return d
}

/**
 * Normalizes and deduplicates a list of domain strings.
 * Invalid entries are silently dropped.
 */
function normalizeDomains(raw: string[]): string[] {
  const seen = new Set<string>()
  for (const entry of raw) {
    const normalized = normalizeDomain(entry)
    if (normalized) seen.add(normalized)
  }
  return Array.from(seen)
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

export const updatePortalVisibilitySchema = z.object({
  visibility: z.enum(['public', 'private']),
  allowedDomains: z.array(z.string()).optional(),
})

export type UpdatePortalVisibilityInput = z.infer<typeof updatePortalVisibilitySchema>

// ---------------------------------------------------------------------------
// Server function
// ---------------------------------------------------------------------------

export const updatePortalAccessFn = createServerFn({ method: 'POST' })
  .inputValidator(updatePortalVisibilitySchema.parse)
  .handler(async ({ data }) => {
    console.log(
      `[fn:portal-access] updatePortalAccessFn: visibility=${data.visibility}, allowedDomains=${JSON.stringify(data.allowedDomains ?? [])}`
    )
    const auth = await requireAuth()
    if (!isAdmin(auth.principal.role)) {
      throw new ForbiddenError('FORBIDDEN', 'Admin only')
    }

    const headers = getRequestHeaders()
    const actor = actorFromAuth(auth)

    const before = await getPortalConfig()

    const normalizedDomains =
      data.allowedDomains !== undefined
        ? normalizeDomains(data.allowedDomains)
        : (before.access?.allowedDomains ?? [])

    const updated = await updatePortalConfig({
      access: { visibility: data.visibility, allowedDomains: normalizedDomains },
    })

    const prevVisibility = before.access?.visibility ?? 'public'
    if (prevVisibility !== data.visibility) {
      await recordAuditEvent({
        event: 'portal.visibility.changed',
        actor,
        headers,
        target: { type: 'settings', id: 'portal-config' },
        before: { visibility: prevVisibility },
        after: { visibility: data.visibility },
      })
    }

    const prevDomains = (before.access?.allowedDomains ?? []).slice().sort()
    const nextDomains = normalizedDomains.slice().sort()
    const domainsChanged =
      prevDomains.length !== nextDomains.length || prevDomains.some((d, i) => d !== nextDomains[i])

    if (data.allowedDomains !== undefined && domainsChanged) {
      await recordAuditEvent({
        event: 'portal.allowed_domains.changed',
        actor,
        headers,
        target: { type: 'settings', id: 'portal-config' },
        before: { allowedDomains: prevDomains },
        after: { allowedDomains: nextDomains },
      })
    }

    return {
      visibility: updated.access?.visibility ?? 'public',
      allowedDomains: updated.access?.allowedDomains ?? [],
    }
  })
