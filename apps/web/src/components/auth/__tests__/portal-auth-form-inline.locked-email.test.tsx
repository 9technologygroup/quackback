// @vitest-environment happy-dom
/**
 * Signing in again uses the ordinary sign-in form with the person's own
 * address filled in and locked: the form opens on the methods step, the
 * address cannot be edited anywhere, and there is no way back to a blank
 * address or to the provider tiles.
 */
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IntlProvider } from 'react-intl'

vi.mock('@tanstack/react-start', () => ({ useServerFn: () => vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  useRouter: () => ({ navigate: vi.fn() }),
}))
vi.mock('@/lib/server/functions/auth', () => ({ lookupAuthMethodsFn: vi.fn() }))
vi.mock('@/lib/client/auth-client', () => ({
  authClient: {
    signIn: { email: vi.fn(), emailOtp: vi.fn(), social: vi.fn() },
    signUp: { email: vi.fn() },
    requestPasswordReset: vi.fn(),
    signOut: vi.fn(),
  },
}))
vi.mock('@/components/auth/oauth-buttons', () => ({
  getEnabledOAuthProviders: () => [{ id: 'google', name: 'Google', type: 'social' }],
  getOAuthRedirectUrl: vi.fn(),
  hasRoutableOidcProvider: () => false,
}))
vi.mock('@/lib/client/hooks/use-auth-broadcast', () => ({
  usePopupTracker: () => ({
    trackPopup: vi.fn(),
    clearPopup: vi.fn(),
    hasPopup: () => false,
    focusPopup: vi.fn(),
  }),
  openAuthPopup: vi.fn(),
  postAuthSuccess: vi.fn(),
  postAuthError: vi.fn(),
  useAuthBroadcast: vi.fn(),
}))
vi.mock('@/components/ui/input-otp', () => ({
  InputOTP: (props: Record<string, unknown>) => <input {...(props as object)} />,
  InputOTPGroup: ({ children }: { children?: ReactNode }) => <>{children}</>,
  InputOTPSlot: () => null,
  InputOTPSeparator: () => null,
  InputOTPSixSlots: () => null,
}))

import { PortalAuthFormInline } from '../portal-auth-form-inline'
import { authClient } from '@/lib/client/auth-client'
import { postAuthSuccess } from '@/lib/client/hooks/use-auth-broadcast'

const EMAIL = 'me@acme.com'
const RETURN = '/admin/approvals?signedInAgain=approve'

function renderLocked(oauth: Record<string, boolean>) {
  return render(
    <IntlProvider locale="en" defaultLocale="en" messages={{}}>
      <PortalAuthFormInline
        mode="login"
        authConfig={{ found: true, oauth: { google: true, ...oauth } }}
        callbackUrl={RETURN}
        lockedEmail={EMAIL}
      />
    </IntlProvider>
  )
}

describe('PortalAuthFormInline with a locked email', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('opens on the methods step with the address filled in and read-only', () => {
    renderLocked({ password: true })
    const field = screen.getByLabelText(/^email$/i) as HTMLInputElement
    expect(field.value).toBe(EMAIL)
    expect(field.readOnly).toBe(true)
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /use a different email/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /sign in with google/i })).not.toBeInTheDocument()
  })

  it('signs in with the locked address', async () => {
    vi.mocked(authClient.signIn.email).mockResolvedValue({ data: {}, error: null } as never)
    renderLocked({ password: true })
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'hunter22' } })
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }))
    await waitFor(() => expect(postAuthSuccess).toHaveBeenCalled())
    expect(authClient.signIn.email).toHaveBeenCalledWith({ email: EMAIL, password: 'hunter22' })
  })

  it('emails a sign-in to the locked address that lands back on the page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderLocked({ password: false, magicLink: true })
    fireEvent.click(screen.getByRole('button', { name: /continue with email/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/auth/portal-signin')
    expect(JSON.parse(String(init.body))).toEqual({ email: EMAIL, callbackURL: RETURN })
  })

  it('keeps the address locked on the forgot-password step', () => {
    renderLocked({ password: true })
    fireEvent.click(screen.getByRole('button', { name: /forgot password/i }))
    const field = screen.getByLabelText(/^email$/i) as HTMLInputElement
    expect(field.value).toBe(EMAIL)
    expect(field.readOnly).toBe(true)
  })
})
