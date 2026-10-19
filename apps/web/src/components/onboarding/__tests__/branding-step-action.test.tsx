// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import type { AutomaticBrandingStatus } from '@/lib/shared/website-branding'
import type { LaunchTask } from '@/lib/shared/launch-checklist'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}))

const hook = vi.hoisted(() => ({
  state: {} as {
    status: AutomaticBrandingStatus | null
    looking?: boolean
    error?: string | null
  },
  accept: vi.fn(),
  lookup: vi.fn(),
}))
vi.mock('@/components/admin/branding/use-automatic-website-branding', () => ({
  useAutomaticWebsiteBranding: () => ({
    status: hook.state.status,
    pending: false,
    looking: hook.state.looking ?? false,
    error: hook.state.error ?? null,
    accept: hook.accept,
    lookup: hook.lookup,
    undo: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

import { BrandingStepAction } from '../branding-step-action'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const task = {
  id: 'customize-branding',
  title: 'Add your logo',
  classification: 'polish',
  isCompleted: false,
  isSkipped: false,
  availability: 'available',
  href: '/admin/settings/general',
} as LaunchTask

const status = (extra: Partial<AutomaticBrandingStatus>): AutomaticBrandingStatus => ({
  domain: 'acme.example',
  status: 'eligible',
  logoUrl: null,
  colorApplied: false,
  canUndo: false,
  canUse: false,
  ...extra,
})

function show() {
  return render(
    <IntlProvider locale="en" messages={{}}>
      <BrandingStepAction task={task} variant="outline" />
    </IntlProvider>
  )
}

describe("the launch plan's branding step", () => {
  it('offers the logo found on the website, applied only with Use it', () => {
    hook.state = {
      status: status({ status: 'offered', canUse: true, logoUrl: '/api/storage/logos/acme.png' }),
    }
    show()
    expect(screen.getByText('Use the logo from acme.example?')).toBeDefined()
    expect(hook.accept).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Use it' }))
    expect(hook.accept).toHaveBeenCalledOnce()
    expect(screen.getByRole('link', { name: 'Upload a logo' })).toHaveAttribute(
      'href',
      '/admin/settings/general'
    )
  })

  it('asks for a website when there is nothing to offer, as for a personal email', () => {
    hook.state = { status: null }
    show()
    const find = screen.getByRole('button', { name: 'Find logo' })
    expect(find).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Your website' }), {
      target: { value: ' acme.example ' },
    })
    fireEvent.click(find)
    expect(hook.lookup).toHaveBeenCalledWith('acme.example')
    expect(screen.getByRole('link', { name: 'Upload a logo' })).toBeDefined()
  })

  it('says when a website had no logo, and keeps the field to try another', () => {
    hook.state = { status: status({ status: 'failed' }) }
    show()
    expect(
      screen.getByText('No logo found on acme.example. Try another website or upload one.')
    ).toBeDefined()
    expect(screen.getByRole('textbox', { name: 'Your website' })).toBeDefined()
  })

  it('shows the lookup running, and its error', () => {
    hook.state = {
      status: status({ status: 'pending' }),
      error: 'Still looking. Try again in a moment.',
    }
    show()
    expect(screen.getByText('Looking for a logo on acme.example…')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Finding…' })).toBeDisabled()
    expect(screen.getByRole('alert').textContent).toBe('Still looking. Try again in a moment.')
  })
})
