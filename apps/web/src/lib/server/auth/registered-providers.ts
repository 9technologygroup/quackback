/**
 * Registered-providers introspection — used by BootstrapData to drive
 * admin login UI decisions (e.g. "show SSO as the default CTA only if
 * it's actually wired up at the auth layer").
 *
 * The registration-truth source is `createAuth()` in `index.ts`. Two
 * places decide whether a provider can sign anyone in:
 * 1. The env-baked / DB-baked SSO_OIDC trio (provider id `sso`)
 * 2. The platform_credentials table for the providers in
 *    AUTH_PROVIDERS — gated by tier-limits.features.customOidcProvider
 *    for the generic-oauth ones.
 *
 * This helper duplicates that logic just enough to answer "which
 * providers would Better-Auth register if it booted right now?"
 * Critically, it returns the actually-usable set rather than the DB
 * intent: a stale `settings.authConfig.ssoOidc.enabled=true` with no
 * SSO_OIDC_CLIENT_SECRET in env is NOT reported as registered, because
 * Better-Auth would reject it at boot.
 */

import { getTenantSettings } from '@/lib/server/domains/settings/settings.service'
import { getTierLimits } from '@/lib/server/domains/settings/tier-limits.service'
import { getConfiguredIntegrationTypes } from '@/lib/server/domains/platform-credentials/platform-credential.service'
import { getAllAuthProviders } from './auth-providers'

export async function getRegisteredAuthProviders(): Promise<string[]> {
  const ids: string[] = []

  // SSO is registered when EITHER (a) DB says enabled AND env has the
  // client secret, or (b) the env trio is fully set on its own.
  const [tenantSettings, tierLimits, configuredTypes] = await Promise.all([
    getTenantSettings(),
    getTierLimits(),
    getConfiguredIntegrationTypes(),
  ])
  const ssoFromDb = tenantSettings?.authConfig?.ssoOidc
  const hasClientSecret = Boolean(process.env.SSO_OIDC_CLIENT_SECRET)
  const dbWantsSso = Boolean(ssoFromDb?.enabled)
  const envHasSso = Boolean(
    process.env.SSO_OIDC_DISCOVERY_URL &&
    process.env.SSO_OIDC_CLIENT_ID &&
    process.env.SSO_OIDC_CLIENT_SECRET
  )
  if ((dbWantsSso && hasClientSecret) || envHasSso) {
    ids.push('sso')
  }

  // Built-in social + custom generic-oauth providers gated by having
  // platform credentials configured. The auth layer also gates
  // generic-oauth on the customOidcProvider tier flag, so mirror that
  // here. `configuredTypes` is the cached Set returned by
  // getConfiguredIntegrationTypes — a single Redis read replaces
  // per-provider DB lookups.
  for (const provider of getAllAuthProviders()) {
    if (!configuredTypes.has(provider.credentialType)) continue
    if (provider.type === 'generic-oauth' && !tierLimits.features.customOidcProvider) continue
    ids.push(provider.id)
  }

  return ids
}
