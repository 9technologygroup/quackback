import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/server/db', () => {
  const chain = { set: () => ({ where: vi.fn() }) }
  const tx = { update: () => chain }
  return {
    db: {
      query: {
        settings: {
          findFirst: vi.fn().mockResolvedValue({ id: 's1', authConfig: '{"oauth":{}}' }),
        },
      },
      update: () => chain,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
      select: () => ({
        from: () => ({
          limit: () => Promise.resolve([]),
          orderBy: () => Promise.resolve([]),
        }),
      }),
    },
    eq: vi.fn(),
    settings: { id: 'id', authConfig: 'auth_config' },
    ssoVerifiedDomain: { id: 'id', createdAt: 'created_at' },
  }
})

vi.mock('@/lib/server/redis', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  CACHE_KEYS: { TENANT_SETTINGS: 'tenant' },
}))

vi.mock('@/lib/server/config-file/managed-guard', () => ({ assertNotManaged: vi.fn() }))

vi.mock('@/lib/server/domains/settings/tier-limits.service', () => ({
  getTierLimits: vi.fn().mockResolvedValue({ features: { customOidcProvider: true } }),
}))

vi.mock('@/lib/server/domains/settings/tier-enforce', () => ({ enforceFeatureGate: vi.fn() }))

vi.mock('@/lib/server/content/ssrf-guard', () => ({
  checkUrlSafety: vi.fn().mockResolvedValue({ safe: true }),
}))

vi.mock('@/lib/server/auth/sso-secret', () => ({
  hasSsoClientSecret: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/lib/server/auth/config-version', () => ({
  bumpAuthConfigVersionInTx: vi.fn(),
}))

vi.mock('@/lib/server/auth', () => ({ resetAuth: vi.fn() }))

describe('updateAuthConfig — autoProvisionRole validation', () => {
  it('rejects autoProvisionRole values outside the enum', async () => {
    const { updateAuthConfig } = await import('../settings.service')
    await expect(
      updateAuthConfig({
        ssoOidc: { autoProvisionRole: 'root' as unknown as 'admin' },
      })
    ).rejects.toThrow(/autoProvisionRole/i)
  })

  it('accepts admin | member | user', async () => {
    const { updateAuthConfig } = await import('../settings.service')
    for (const role of ['admin', 'member', 'user'] as const) {
      await expect(
        updateAuthConfig({ ssoOidc: { autoProvisionRole: role } })
      ).resolves.toBeDefined()
    }
  })
})
