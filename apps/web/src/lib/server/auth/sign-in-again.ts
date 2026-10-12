/**
 * The sign-in-again options for the signed-in person: which of the
 * workspace's sign-in methods they use, read from the same sources the
 * sign-in form routes on (`lookupAuthMethodsFn`), plus their own linked
 * sign-ins. The decision itself is `resolveSignInAgainMethods`.
 */
import type { UserId } from '@quackback/ids'
import { account, db, desc, eq } from '@/lib/server/db'
import { getAuthProviderByProviderId } from '@/lib/server/auth/auth-providers'
import { hasRecentSignIn } from '@/lib/server/auth/recent-sign-in'
import {
  getRegisteredAuthProviders,
  getRegisteredOidcProviderIds,
} from '@/lib/server/auth/registered-providers'
import { getWorkspaceSettings } from '@/lib/server/domains/settings/settings.service'
import { listIdentityProviders } from '@/lib/server/domains/settings/identity-providers.service'
import { resolveLoginRouting } from '@/lib/server/functions/auth-routing'
import {
  resolveSignInAgainMethods,
  type SignInAgainOptions,
  type SignInAgainProvider,
} from '@/lib/shared/sign-in-again'

/** Better Auth's provider id for an email-and-password account. */
const PASSWORD_PROVIDER_ID = 'credential'

export async function signInAgainOptionsFor(caller: {
  user: { id: UserId | string; email: string }
}): Promise<SignInAgainOptions> {
  const [workspace, identityProviders, registeredIds, accounts, fresh] = await Promise.all([
    getWorkspaceSettings(),
    listIdentityProviders(),
    getRegisteredAuthProviders(),
    db
      .select({ providerId: account.providerId })
      .from(account)
      .where(eq(account.userId, caller.user.id as UserId))
      .orderBy(desc(account.updatedAt)),
    hasRecentSignIn(caller),
  ])
  const registeredOidc = await getRegisteredOidcProviderIds(identityProviders)

  const routing = resolveLoginRouting(
    caller.user.email,
    identityProviders.map((p) => ({
      registrationId: p.registrationId,
      enabled: p.enabled,
      registered: registeredOidc.has(p.registrationId),
      credsPresent: registeredOidc.has(p.registrationId),
      domains: p.domains,
    }))
  )

  const oidcLabels = new Map(identityProviders.map((p) => [p.registrationId, p.label]))
  const registered: SignInAgainProvider[] = registeredIds.map((id) => {
    const label = oidcLabels.get(id)
    if (label !== undefined) return { id, name: label, type: 'oidc' }
    return { id, name: getAuthProviderByProviderId(id)?.name ?? id, type: 'social' }
  })

  const publicAuth = workspace?.publicAuthConfig
  const methods = resolveSignInAgainMethods({
    routing,
    linkedProviderIds: accounts
      .map((a) => a.providerId)
      .filter((id) => id !== PASSWORD_PROVIDER_ID),
    hasPassword: accounts.some((a) => a.providerId === PASSWORD_PROVIDER_ID),
    registered,
    oauth: publicAuth?.oauth ?? {},
    twoFactorRequired: publicAuth?.twoFactor?.required ?? false,
  })

  return { userId: caller.user.id, email: caller.user.email, fresh, ...methods }
}
