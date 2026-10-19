import { describe, expect, it } from 'vitest'
import { RECENT_SIGN_IN_WINDOW_MS } from '@/lib/shared/recent-sign-in'
import {
  SIGN_IN_AGAIN_PARAM,
  readSignInAgainMarker,
  signInAgainProviderRequest,
  signInAgainReturnUrl,
  stashSignInAgain,
  stripSignInAgainSearch,
  takeSignInAgain,
  withoutSignInAgainMarker,
} from '../sign-in-again'

const PAGE = 'https://acme.example.com/admin/approvals?status=open#row-3'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  }
}

describe('signInAgainReturnUrl', () => {
  it('comes back to this page, marked with the action', () => {
    expect(signInAgainReturnUrl(PAGE, 'approve:act_1')).toBe(
      `/admin/approvals?status=open&${SIGN_IN_AGAIN_PARAM}=approve%3Aact_1`
    )
  })

  it('replaces the marker and error of an earlier attempt', () => {
    const again = `https://acme.example.com/admin/approvals?${SIGN_IN_AGAIN_PARAM}=old&error=access_denied`
    expect(signInAgainReturnUrl(again, 'new')).toBe(`/admin/approvals?${SIGN_IN_AGAIN_PARAM}=new`)
  })
})

describe('the marker', () => {
  it('reads the action back', () => {
    const back = `https://acme.example.com${signInAgainReturnUrl(PAGE, 'approve:act_1')}`
    expect(readSignInAgainMarker(back)).toEqual({ action: 'approve:act_1', error: null })
  })

  it('reads the error the sign-in appends on failure', () => {
    const failed = `https://acme.example.com/admin/approvals?${SIGN_IN_AGAIN_PARAM}=a&error=access_denied`
    expect(readSignInAgainMarker(failed)).toEqual({ action: 'a', error: 'access_denied' })
  })

  it('is absent on an ordinary page', () => {
    expect(readSignInAgainMarker(PAGE)).toBeNull()
  })

  it('is removed with its error, leaving the rest of the page alone', () => {
    const failed = `https://acme.example.com/admin/approvals?status=open&${SIGN_IN_AGAIN_PARAM}=a&error=x&error_description=y#row-3`
    expect(withoutSignInAgainMarker(failed)).toBe('/admin/approvals?status=open#row-3')
    expect(withoutSignInAgainMarker(PAGE)).toBe('/admin/approvals?status=open#row-3')
  })
})

describe('stripSignInAgainSearch', () => {
  it('drops the marker and the error that came with it, keeping the rest', () => {
    expect(
      stripSignInAgainSearch({
        status: 'open',
        [SIGN_IN_AGAIN_PARAM]: 'a',
        error: 'access_denied',
        error_description: 'no',
      })
    ).toEqual({ status: 'open' })
  })

  it("leaves a page's own error alone when there is no marker", () => {
    const search = { status: 'open', error: 'not_found' }
    expect(stripSignInAgainSearch(search)).toEqual(search)
  })
})

describe('the stash', () => {
  it('hands the action back once, for the person who left', () => {
    const storage = memoryStorage()
    stashSignInAgain({ action: 'a', userId: 'user_me' }, storage, 1000)
    expect(takeSignInAgain('a', storage, 2000)).toEqual({
      action: 'a',
      userId: 'user_me',
      startedAt: 1000,
    })
    expect(takeSignInAgain('a', storage, 2000)).toBeNull()
  })

  it('ignores another action', () => {
    const storage = memoryStorage()
    stashSignInAgain({ action: 'a', userId: 'user_me' }, storage, 1000)
    expect(takeSignInAgain('b', storage, 2000)).toBeNull()
  })

  it('ignores a stash older than the window', () => {
    const storage = memoryStorage()
    stashSignInAgain({ action: 'a', userId: 'user_me' }, storage, 1000)
    expect(takeSignInAgain('a', storage, 1000 + RECENT_SIGN_IN_WINDOW_MS + 1)).toBeNull()
  })

  it('treats unreadable storage as empty', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    } as unknown as Storage
    expect(() => stashSignInAgain({ action: 'a', userId: 'u' }, broken)).not.toThrow()
    expect(takeSignInAgain('a', broken)).toBeNull()
  })
})

describe('signInAgainProviderRequest', () => {
  const back = '/admin/approvals?signedInAgain=a'

  it('returns to this page on success and on failure', () => {
    const request = signInAgainProviderRequest(
      { id: 'oidc_okta', name: 'Okta', type: 'oidc' },
      'me@acme.com',
      back
    )
    expect(request).toEqual({
      providerId: 'oidc_okta',
      callbackURL: back,
      errorCallbackURL: back,
      loginHint: 'me@acme.com',
    })
  })

  it('names the account to an identity provider but sends no social hint', () => {
    expect(
      signInAgainProviderRequest({ id: 'google', name: 'Google', type: 'social' }, 'me@x.com', back)
    ).toEqual({ providerId: 'google', callbackURL: back, errorCallbackURL: back })
  })

  it('never forces a prompt, a maximum age or an account picker', () => {
    for (const type of ['oidc', 'social'] as const) {
      const request = signInAgainProviderRequest({ id: 'p', name: 'P', type }, 'me@x.com', back)
      const sent = JSON.stringify(request)
      expect(sent).not.toMatch(/prompt|max_age|maxAge|select_account|additionalParams/)
    }
  })
})
