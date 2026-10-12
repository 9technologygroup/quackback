/**
 * The sign-in-again options are read from the same sources the sign-in form
 * routes on: the workspace's method switches, its identity providers and their
 * verified domains, and the account's own linked sign-ins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  settings: vi.fn(),
  providers: vi.fn(),
  registeredOidc: vi.fn(),
  registeredAll: vi.fn(),
  accounts: vi.fn(),
  fresh: vi.fn(),
}))

vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  getWorkspaceSettings: () => hoisted.settings(),
}))
vi.mock('@/lib/server/domains/settings/identity-providers.service', () => ({
  listIdentityProviders: () => hoisted.providers(),
}))
vi.mock('@/lib/server/auth/registered-providers', () => ({
  getRegisteredOidcProviderIds: () => hoisted.registeredOidc(),
  getRegisteredAuthProviders: () => hoisted.registeredAll(),
}))
vi.mock('@/lib/server/auth/recent-sign-in', () => ({
  hasRecentSignIn: (...args: unknown[]) => hoisted.fresh(...args),
}))
vi.mock('@/lib/server/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/db')>()
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => hoisted.accounts(),
  }
  return { ...actual, db: { select: () => chain } }
})

const { signInAgainOptionsFor } = await import('../sign-in-again')

const caller = { user: { id: 'user_me', email: 'me@acme.com' } }

const okta = {
  registrationId: 'oidc_okta',
  label: 'Okta',
  enabled: true,
  domains: [{ name: 'acme.com', verifiedAt: '2026-01-01T00:00:00Z', enforced: true }],
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.settings.mockResolvedValue({
    publicAuthConfig: { oauth: { password: true, magicLink: false, google: true } },
  })
  hoisted.providers.mockResolvedValue([okta])
  hoisted.registeredOidc.mockResolvedValue(new Set(['oidc_okta']))
  hoisted.registeredAll.mockResolvedValue(['oidc_okta', 'google'])
  hoisted.accounts.mockResolvedValue([{ providerId: 'credential' }])
  hoisted.fresh.mockResolvedValue(false)
})

describe('signInAgainOptionsFor', () => {
  it('routes an enforced domain to its provider by the provider label', async () => {
    expect(await signInAgainOptionsFor(caller)).toEqual({
      userId: 'user_me',
      email: 'me@acme.com',
      fresh: false,
      providers: [{ id: 'oidc_okta', name: 'Okta', type: 'oidc' }],
      emailMethods: null,
    })
  })

  it('offers a password account the locked email form', async () => {
    hoisted.providers.mockResolvedValue([{ ...okta, domains: [] }])
    const options = await signInAgainOptionsFor(caller)
    expect(options.providers).toEqual([])
    expect(options.emailMethods).toEqual({
      password: true,
      magicLink: false,
      twoFactorRequired: false,
    })
  })

  it("offers the person's own social sign-in by its name", async () => {
    hoisted.providers.mockResolvedValue([{ ...okta, domains: [] }])
    hoisted.accounts.mockResolvedValue([{ providerId: 'google' }])
    const options = await signInAgainOptionsFor(caller)
    expect(options.providers).toEqual([{ id: 'google', name: 'Google', type: 'social' }])
    expect(options.emailMethods).toBeNull()
  })

  it('reports whether the person is already fresh, for this caller', async () => {
    hoisted.fresh.mockResolvedValue(true)
    expect((await signInAgainOptionsFor(caller)).fresh).toBe(true)
    expect(hoisted.fresh).toHaveBeenCalledWith(caller)
  })
})
