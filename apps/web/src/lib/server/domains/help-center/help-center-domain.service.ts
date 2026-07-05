/**
 * Help center custom domain (domains/languages §1). OSS does not automate TLS
 * or DNS -- the operator CNAMEs their domain to this instance and terminates
 * TLS in their own proxy. This module owns:
 *  - normalizing/persisting the configured domain,
 *  - the "Verify" check (DNS resolves + the instance answers on it),
 *  - the pure host-matching helpers the router/bootstrap layer uses for the
 *    default-host -> custom-domain 301 and for domain-aware canonical URLs.
 */
import { resolve4, resolve6 } from 'node:dns/promises'
import { normalizeDomain } from '@/lib/server/auth/normalize-domain'
import { ValidationError } from '@/lib/shared/errors'
import { logger } from '@/lib/server/logger'
import {
  getHelpCenterConfig,
  updateHelpCenterConfig,
} from '@/lib/server/domains/settings/settings.service'
import type { HelpCenterDomainConfig } from '@/lib/server/domains/settings/settings.types'

const log = logger.child({ component: 'help-center-domain' })

/** Same probe path the request-context middleware treats as a health check. */
const HEALTH_PATH = '/api/health'
const REACHABILITY_TIMEOUT_MS = 5000

export interface HelpCenterDomainStatus {
  dnsResolved: boolean
  instanceReachable: boolean
  verified: boolean
}

/** Resolves A then AAAA records; either succeeding counts as "DNS resolves". */
async function domainResolves(domain: string): Promise<boolean> {
  try {
    const addrs = await resolve4(domain)
    if (addrs.length > 0) return true
  } catch {
    // fall through to AAAA
  }
  try {
    const addrs = await resolve6(domain)
    return addrs.length > 0
  } catch {
    return false
  }
}

/**
 * Whether this exact instance answers on the domain. A plain HTTPS GET to
 * the liveness path proves the CNAME + the operator's proxy both terminate
 * on us -- no shared secret needed for a v1 status check.
 */
async function instanceAnswersOn(domain: string): Promise<boolean> {
  try {
    const res = await fetch(`https://${domain}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Read-only status check, used both by the "Verify" action and its status chip. */
export async function checkHelpCenterDomainStatus(domain: string): Promise<HelpCenterDomainStatus> {
  const [dnsResolved, instanceReachable] = await Promise.all([
    domainResolves(domain),
    instanceAnswersOn(domain),
  ])
  return { dnsResolved, instanceReachable, verified: dnsResolved && instanceReachable }
}

/**
 * Set (or clear) the configured domain. Changing the domain always resets
 * verification -- a new hostname has never passed the check.
 */
export async function setHelpCenterDomain(
  domainInput: string | null
): Promise<HelpCenterDomainConfig> {
  if (domainInput === null || domainInput.trim() === '') {
    const updated = await updateHelpCenterConfig({ domain: { domain: null, verifiedAt: null } })
    return updated.domain
  }
  const normalized = normalizeDomain(domainInput)
  if (!normalized) {
    throw new ValidationError('HC_DOMAIN_INVALID', 'Must be a public FQDN (e.g. "help.acme.com")')
  }
  const updated = await updateHelpCenterConfig({
    domain: { domain: normalized, verifiedAt: null },
  })
  return updated.domain
}

/**
 * Run the verify check against the currently configured domain and persist
 * the result. A previously-verified domain that stops answering is
 * un-verified again (verifiedAt cleared) so the 301 doesn't strand visitors
 * on a dead host.
 */
export async function verifyHelpCenterDomain(): Promise<{
  config: HelpCenterDomainConfig
  status: HelpCenterDomainStatus
}> {
  const current = await getHelpCenterConfig()
  const domain = current.domain?.domain
  if (!domain) {
    throw new ValidationError('HC_DOMAIN_NOT_SET', 'Set a domain before verifying it')
  }

  const status = await checkHelpCenterDomainStatus(domain)
  log.info({ domain, status }, 'help center domain verify check')
  const verifiedAt = status.verified ? new Date().toISOString() : null
  const updated = await updateHelpCenterConfig({ domain: { domain, verifiedAt } })
  return { config: updated.domain, status }
}

/**
 * Full-coverage 301: once a domain is verified, every /hc/* request on the
 * default host redirects to the same path on the custom domain. Pure so the
 * router layer (which owns the actual request Host) can unit test it without
 * a live request. Returns null when no redirect is needed.
 */
export function resolveHelpCenterDomainRedirect(params: {
  domainConfig: HelpCenterDomainConfig | null | undefined
  currentHost: string | null
  pathname: string
  search: string
}): string | null {
  const { domainConfig, currentHost, pathname, search } = params
  if (!domainConfig?.domain || !domainConfig?.verifiedAt) return null
  if (!currentHost) return null

  const host = currentHost.split(':')[0]?.toLowerCase()
  const target = domainConfig.domain.toLowerCase()
  if (!host || host === target) return null

  return `https://${target}${pathname}${search}`
}

/**
 * Canonical-URL base for the current request: the verified custom domain
 * when the request actually arrived on it, else the fallback (global
 * BASE_URL). Pure for the same reason as {@link resolveHelpCenterDomainRedirect}.
 */
export function resolveHelpCenterBaseUrl(params: {
  domainConfig: HelpCenterDomainConfig | null | undefined
  currentHost: string | null
  fallback: string
}): string {
  const { domainConfig, currentHost, fallback } = params
  if (!domainConfig?.domain || !domainConfig?.verifiedAt || !currentHost) return fallback

  const host = currentHost.split(':')[0]?.toLowerCase()
  if (host !== domainConfig.domain.toLowerCase()) return fallback

  return `https://${domainConfig.domain}`
}
