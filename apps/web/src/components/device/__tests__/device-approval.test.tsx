// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IntlProvider } from 'react-intl'

const fns = vi.hoisted(() => ({ lookup: vi.fn(), decide: vi.fn(), signInAgain: vi.fn() }))
vi.mock('@/lib/client/hooks/use-sign-in-again', () => ({
  useSignInAgain: () => ({ request: fns.signInAgain, dialog: {} }),
}))
vi.mock('@/components/auth/sign-in-again-dialog', () => ({ SignInAgainDialog: () => null }))
vi.mock('@/lib/server/functions/device-auth', () => ({
  lookupDeviceCodeFn: fns.lookup,
  decideDeviceCodeFn: fns.decide,
}))

import { DeviceApproval } from '../device-approval'

function renderPage(userCode: string | undefined, onCode = vi.fn()) {
  render(
    <IntlProvider locale="en" defaultLocale="en" onError={() => {}}>
      <DeviceApproval userCode={userCode} onCode={onCode} />
    </IntlProvider>
  )
  return onCode
}

const ready = {
  state: 'ready' as const,
  userCode: 'ABCD2345',
  clientName: 'Headless CLI',
  clientUri: 'https://cli.example.com',
  clientIcon: 'https://tracker.example.com/pixel.png',
  requestedScope: 'openid offline_access read:feedback write:feedback read:article',
}

beforeEach(() => {
  fns.lookup.mockReset()
  fns.decide.mockReset()
  fns.signInAgain.mockReset()
})
afterEach(cleanup)

describe('DeviceApproval', () => {
  it('asks for a code when the link carried none', () => {
    const onCode = renderPage(undefined)
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'abcd2345' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onCode).toHaveBeenCalledWith('abcd2345')
    expect(fns.lookup).not.toHaveBeenCalled()
  })

  it('shows the client and code, and keeps the choices within the request', async () => {
    fns.lookup.mockResolvedValue(ready)
    renderPage('ABCD2345')

    expect(await screen.findByText('Headless CLI')).toBeTruthy()
    expect(screen.getByText('ABCD2345')).toBeTruthy()
    expect(screen.getByText('cli.example.com')).toBeTruthy()
    // Anyone can register a client under any name, so the page says so and
    // never fetches an image the client chose.
    expect(screen.getByText(/Unverified application/)).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()

    // Feedback and help center reads were asked for, writes only for feedback; conversations not at all.
    const feedbackWrite = screen.getByRole('button', { name: /Feedback: Read and write/ })
    expect((feedbackWrite as HTMLButtonElement).disabled).toBe(false)
    const helpCenterWrite = screen.getByRole('button', { name: /Help Center: Read and write/ })
    expect((helpCenterWrite as HTMLButtonElement).disabled).toBe(true)
    const conversationsRead = screen.getByRole('button', { name: /Conversations: Read$/ })
    expect((conversationsRead as HTMLButtonElement).disabled).toBe(true)
  })

  it('approves what was chosen and says the client finishes on its own', async () => {
    fns.lookup.mockResolvedValue(ready)
    fns.decide.mockResolvedValue({ ok: true, status: 'approved' })
    renderPage('ABCD2345')

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(fns.decide).toHaveBeenCalledTimes(1))
    const call = fns.decide.mock.calls[0]![0] as {
      data: { userCode: string; accept: boolean; selectedScopes: string[]; offlineAccess: boolean }
    }
    expect(call.data).toMatchObject({ userCode: 'ABCD2345', accept: true, offlineAccess: true })
    expect(call.data.selectedScopes).toEqual(
      expect.arrayContaining(['read:feedback', 'write:feedback', 'read:article'])
    )
    expect(await screen.findByText(/Headless CLI finishes signing in on its own/)).toBeTruthy()
  })

  it('denies on request', async () => {
    fns.lookup.mockResolvedValue(ready)
    fns.decide.mockResolvedValue({ ok: true, status: 'denied' })
    renderPage('ABCD2345')

    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }))
    expect(await screen.findByText('Request denied')).toBeTruthy()
    expect((fns.decide.mock.calls[0]![0] as { data: { accept: boolean } }).data.accept).toBe(false)
  })

  it.each([
    ['invalid', /not valid/],
    ['expired', /has expired/],
    ['unavailable', /opened by another account/],
  ])('explains a %s code', async (state, message) => {
    fns.lookup.mockResolvedValue({ state })
    renderPage('ZZZZ')
    expect(await screen.findByText(message)).toBeTruthy()
  })

  it('asks to sign in again when the session is stale, and does not approve', async () => {
    fns.lookup.mockResolvedValue(ready)
    fns.decide.mockResolvedValue({
      ok: false,
      code: 'RECENT_SIGN_IN_REQUIRED',
      message: 'Sign in again to continue.',
    })
    renderPage('ABCD2345')

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(fns.signInAgain).toHaveBeenCalledWith('device:accept'))
    expect(screen.queryByText('Approved')).toBeNull()
  })
})
