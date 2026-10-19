/**
 * How a person signs in again: through the workspace's normal sign-in, for
 * their own account. Pure, so the server can decide it and both sides can
 * share the answer's shape.
 *
 * - A domain that enforces SSO means that provider and nothing else.
 * - Otherwise the person's own identity providers that the workspace still
 *   offers, with the provider that owns their domain first.
 * - The email form (password, emailed code or link) when the person can use
 *   it here: a password account with passwords on, or sign-in links on. It is
 *   also the fallback, so the dialog never offers nothing.
 */

export interface SignInAgainProvider {
  /** Better Auth provider id: a social id such as `google`, or an OIDC registration id. */
  id: string
  name: string
  type: 'oidc' | 'social'
}

/** The workspace's email methods for the person's own, locked address. */
export interface SignInAgainEmailMethods {
  password: boolean
  magicLink: boolean
  twoFactorRequired: boolean
}

/** What the sign-in-again dialog needs to know about the person. */
export interface SignInAgainOptions {
  userId: string
  email: string
  /** The person signed in within the window already. */
  fresh: boolean
  providers: SignInAgainProvider[]
  /** Null when the person must use one of the providers. */
  emailMethods: SignInAgainEmailMethods | null
}

export interface SignInAgainInput {
  /** The email-domain routing the sign-in form applies to the person's address. */
  routing: { kind: 'sso-redirect' | 'sso-default' | 'methods'; providerId?: string }
  /** Identity providers linked to the account, most recently used first. */
  linkedProviderIds: readonly string[]
  /** The account has a password. */
  hasPassword: boolean
  /** Providers the workspace offers for sign-in right now. */
  registered: readonly SignInAgainProvider[]
  /** The workspace's sign-in method switches. */
  oauth: { password?: boolean; magicLink?: boolean }
  twoFactorRequired: boolean
}

export function resolveSignInAgainMethods(
  input: SignInAgainInput
): Pick<SignInAgainOptions, 'providers' | 'emailMethods'> {
  const byId = new Map(input.registered.map((p) => [p.id, p]))
  const owner = input.routing.providerId
    ? (byId.get(input.routing.providerId) ?? {
        id: input.routing.providerId,
        name: input.routing.providerId,
        type: 'oidc' as const,
      })
    : null

  if (input.routing.kind === 'sso-redirect' && owner) {
    return { providers: [owner], emailMethods: null }
  }

  const providers: SignInAgainProvider[] = []
  const add = (provider: SignInAgainProvider | undefined) => {
    if (provider && !providers.some((p) => p.id === provider.id)) providers.push(provider)
  }
  if (input.routing.kind === 'sso-default') add(owner ?? undefined)
  for (const id of input.linkedProviderIds) add(byId.get(id))

  const password = input.oauth.password !== false
  const magicLink = input.oauth.magicLink === true
  const usable = (password && input.hasPassword) || magicLink
  const emailMethods =
    usable || providers.length === 0
      ? { password, magicLink, twoFactorRequired: input.twoFactorRequired }
      : null

  return { providers, emailMethods }
}
