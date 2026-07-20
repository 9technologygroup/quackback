// @vitest-environment happy-dom
/**
 * Portal New-Ticket dialog — convergence Phase 4: the intake type picker
 * appears only when more than one intake-visible customer type is offered,
 * the workspace default type is preselected with its field set rendered, a
 * swap exchanges the fields, and the submit carries ticketTypeId + the
 * validated answers (the same validator the server enforces).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IntlProvider } from 'react-intl'
import type { ReactNode } from 'react'
import type { TicketIntakeType } from '@/lib/shared/tickets'

const mocks = vi.hoisted(() => ({
  createMyTicketFn: vi.fn(),
  getMyTicketFormFn: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@/lib/server/functions/tickets', () => ({
  createMyTicketFn: mocks.createMyTicketFn,
  getMyTicketFormFn: mocks.getMyTicketFormFn,
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))
vi.mock('@/components/ui/rich-text-editor', () => ({ RichTextEditor: () => null }))
vi.mock('@/lib/client/hooks/use-image-upload', () => ({
  usePortalImageUpload: () => ({ upload: vi.fn() }),
}))

import { NewPortalTicketDialog } from '../new-portal-ticket-dialog'

const field = (over: Partial<TicketIntakeType['fields'][number]>) => ({
  key: 'field',
  label: 'Field',
  type: 'text' as const,
  required: false,
  visibleToCustomer: true,
  order: 0,
  ...over,
})

const generalType: TicketIntakeType = {
  id: 'ticket_type_general',
  name: 'General question',
  icon: '💬',
  color: '#0ea5e9',
  isDefault: true,
  fields: [],
}

const bugType: TicketIntakeType = {
  id: 'ticket_type_bug',
  name: 'Bug report',
  icon: '🐛',
  color: '#eab308',
  isDefault: false,
  fields: [field({ key: 'severity', label: 'Severity', required: true })],
}

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <IntlProvider locale="en" messages={{}}>
        {children}
      </IntlProvider>
    </QueryClientProvider>
  )
}

/** Keyboard-open a Radix Select (happy-dom doesn't open it on pointerDown). */
async function pickSelectOption(trigger: HTMLElement, optionText: string) {
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const option = await screen.findByRole('option', { name: new RegExp(optionText) })
  fireEvent.click(option)
}

beforeEach(() => {
  Element.prototype.scrollIntoView ??= (() => {}) as never
  mocks.createMyTicketFn.mockReset()
  mocks.getMyTicketFormFn.mockReset()
  mocks.navigate.mockReset()
  mocks.getMyTicketFormFn.mockResolvedValue({ types: [generalType, bugType] })
})

afterEach(cleanup)

describe('NewPortalTicketDialog — Phase 4 intake picker', () => {
  it('shows the type picker only when more than one intake type is offered', async () => {
    render(<NewPortalTicketDialog open onOpenChange={vi.fn()} />, { wrapper: wrapper() })
    expect(await screen.findByText('Type')).toBeInTheDocument()
    cleanup()

    mocks.getMyTicketFormFn.mockResolvedValue({ types: [generalType] })
    render(<NewPortalTicketDialog open onOpenChange={vi.fn()} />, { wrapper: wrapper() })
    // Wait for the form to load (Subject is always there) then assert no picker.
    expect(await screen.findByText('Subject')).toBeInTheDocument()
    await waitFor(() => expect(mocks.getMyTicketFormFn).toHaveBeenCalled())
    expect(screen.queryByText('Type')).toBeNull()
  })

  it('preselects the workspace default type and renders its fields', async () => {
    render(<NewPortalTicketDialog open onOpenChange={vi.fn()} />, { wrapper: wrapper() })
    // The default (General question) leads; the bug form's field is absent.
    expect(await screen.findByText('General question')).toBeInTheDocument()
    expect(screen.queryByText('Severity')).toBeNull()

    // Swapping to Bug report exchanges the field set.
    await pickSelectOption(await screen.findByRole('combobox'), 'Bug report')
    expect(await screen.findByText('Severity')).toBeInTheDocument()
  })

  it('blocks on a required type field, then submits with ticketTypeId + validated answers', async () => {
    mocks.createMyTicketFn.mockResolvedValue({ id: 'ticket_1' })
    render(<NewPortalTicketDialog open onOpenChange={vi.fn()} />, { wrapper: wrapper() })

    await pickSelectOption(await screen.findByRole('combobox'), 'Bug report')
    fireEvent.change(await screen.findByPlaceholderText('Summarize your request…'), {
      target: { value: 'Export is broken' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create ticket' }))

    // Required type field enforced inline before anything is sent.
    expect(await screen.findByText('Severity is required')).toBeInTheDocument()
    expect(mocks.createMyTicketFn).not.toHaveBeenCalled()

    const severityInput = (await screen.findByText('Severity')).parentElement!.querySelector(
      'input'
    )!
    fireEvent.change(severityInput, { target: { value: 'High' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create ticket' }))

    await waitFor(() => expect(mocks.createMyTicketFn).toHaveBeenCalledTimes(1))
    expect(mocks.createMyTicketFn).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: 'Export is broken',
        ticketTypeId: 'ticket_type_bug',
        fieldValues: { severity: 'High' },
      }),
    })
  })
})
