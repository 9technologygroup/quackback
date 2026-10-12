import { describe, expect, it } from 'vitest'
import { resolveSignInAgainMethods, type SignInAgainProvider } from '../sign-in-again'

const okta: SignInAgainProvider = { id: 'oidc_okta', name: 'Okta', type: 'oidc' }
const google: SignInAgainProvider = { id: 'google', name: 'Google', type: 'social' }
const github: SignInAgainProvider = { id: 'github', name: 'GitHub', type: 'social' }

const base = {
  routing: { kind: 'methods' as const },
  linkedProviderIds: [] as string[],
  hasPassword: false,
  registered: [okta, google, github],
  oauth: { password: true, magicLink: false },
  twoFactorRequired: false,
}

describe('resolveSignInAgainMethods', () => {
  it('sends a person whose domain enforces SSO through that provider only', () => {
    const methods = resolveSignInAgainMethods({
      ...base,
      routing: { kind: 'sso-redirect', providerId: 'oidc_okta' },
      hasPassword: true,
      oauth: { password: true, magicLink: true },
      linkedProviderIds: ['google'],
    })
    expect(methods).toEqual({ providers: [okta], emailMethods: null })
  })

  it('sends a person who signs in with an identity provider through it', () => {
    expect(resolveSignInAgainMethods({ ...base, linkedProviderIds: ['google'] })).toEqual({
      providers: [google],
      emailMethods: null,
    })
  })

  it('offers the email form to a password account', () => {
    expect(resolveSignInAgainMethods({ ...base, hasPassword: true })).toEqual({
      providers: [],
      emailMethods: { password: true, magicLink: false, twoFactorRequired: false },
    })
  })

  it('offers the email form when the workspace sends sign-in links', () => {
    expect(
      resolveSignInAgainMethods({
        ...base,
        oauth: { password: false, magicLink: true },
        linkedProviderIds: ['github'],
      })
    ).toEqual({
      providers: [github],
      emailMethods: { password: false, magicLink: true, twoFactorRequired: false },
    })
  })

  it('carries the two-factor policy to the email form', () => {
    expect(
      resolveSignInAgainMethods({ ...base, hasPassword: true, twoFactorRequired: true })
        .emailMethods
    ).toEqual({ password: true, magicLink: false, twoFactorRequired: true })
  })

  it('puts the provider that owns the domain first when SSO is the default', () => {
    const methods = resolveSignInAgainMethods({
      ...base,
      routing: { kind: 'sso-default', providerId: 'oidc_okta' },
      hasPassword: true,
      linkedProviderIds: ['google', 'oidc_okta'],
    })
    expect(methods.providers).toEqual([okta, google])
    expect(methods.emailMethods).not.toBeNull()
  })

  it('skips linked providers the workspace no longer offers', () => {
    expect(
      resolveSignInAgainMethods({
        ...base,
        registered: [google],
        linkedProviderIds: ['oidc_gone', 'google'],
      }).providers
    ).toEqual([google])
  })

  it('falls back to the email form rather than offering nothing', () => {
    expect(resolveSignInAgainMethods(base)).toEqual({
      providers: [],
      emailMethods: { password: true, magicLink: false, twoFactorRequired: false },
    })
  })

  it('never offers a password the workspace turned off', () => {
    expect(
      resolveSignInAgainMethods({
        ...base,
        hasPassword: true,
        oauth: { password: false, magicLink: false },
        linkedProviderIds: ['google'],
      })
    ).toEqual({ providers: [google], emailMethods: null })
  })
})
