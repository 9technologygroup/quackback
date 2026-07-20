// @vitest-environment happy-dom
/**
 * Create-ticket dialog — convergence Phase 4: the registry type picker
 * (category default preselected), the type swap exchanging the dynamic field
 * set, inline validation against the chosen type's fields, and the submit
 * payload carrying ticketTypeId + validated customAttributes (never a bare
 * category alongside a registry type).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IntlProvider } from 'react-intl'
import type { ReactNode } from 'react'
import type { TicketTypeDTO } from '@/lib/shared/tickets'

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  listTicketTypesFn: vi.fn(),
  linkTicketToConversationFn: vi.fn(),
}))

vi.mock('@/lib/client/mutations/inbox', () => ({
  useCreateTicket: () => ({ mutate: mocks.mutate, isPending: false }),
}))
vi.mock('@/lib/server/functions/ticket-types', () => ({
  listTicketTypesFn: mocks.listTicketTypesFn,
}))
vi.mock('@/lib/server/functions/tickets', () => ({
  linkTicketToConversationFn: mocks.linkTicketToConversationFn,
}))
// Heavy/irrelevant children stubbed: the rich editor (tiptap), image upload,
// and the requester picker (covered by its own surface).
vi.mock('@/components/ui/rich-text-editor', () => ({ RichTextEditor: () => null }))
vi.mock('@/lib/client/hooks/use-image-upload', () => ({
  useImageUpload: () => ({ upload: vi.fn() }),
}))
vi.mock('@/components/shared/portal-user-picker', () => ({ PortalUserPicker: () => null }))

import { CreateTicketDialog } from '../create-ticket-dialog'

const field = (over: Partial<TicketTypeDTO['fields'][number]>) => ({
  key: 'field',
  label: 'Field',
  type: 'text' as const,
  required: false,
  visibleToCustomer: true,
  order: 0,
  ...over,
})

const bugType: TicketTypeDTO = {
  id: 'ticket_type_bug',
  name: 'Bug report',
  slug: 'bug_report',
  category: 'customer',
  icon: '🐛',
  color: '#eab308',
  fields: [field({ key: 'steps', label: 'Steps to reproduce' })],
  isDefault: true,
  position: 0,
  intakeVisible: true,
  archived: false,
}

const refundType: TicketTypeDTO = {
  id: 'ticket_type_refund',
  name: 'Refund request',
  slug: 'refund_request',
  category: 'customer',
  icon: '💳',
  color: '#22c55e',
  fields: [field({ key: 'order_id', label: 'Order id', required: true })],
  isDefault: false,
  position: 1,
  intakeVisible: true,
  archived: false,
}

const outageType: TicketTypeDTO = {
  id: 'ticket_type_outage',
  name: 'Outage',
  slug: 'outage',
  category: 'tracker',
  icon: '📡',
  color: '#6b7280',
  fields: [],
  isDefault: true,
  position: 0,
  intakeVisible: false,
  archived: false,
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

function renderDialog(props: Partial<Parameters<typeof CreateTicketDialog>[0]> = {}) {
  return render(<CreateTicketDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} {...props} />, {
    wrapper: wrapper(),
  })
}

/** Open a Radix Select and pick one of its options by visible text. happy-dom
 *  doesn't open the popover on pointerDown, but ArrowDown on the focused
 *  trigger works (the repo's DropdownMenu tests use pointerDown instead). */
async function pickSelectOption(trigger: HTMLElement, optionText: string) {
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const option = await screen.findByRole('option', { name: new RegExp(optionText) })
  fireEvent.click(option)
}

beforeEach(() => {
  Element.prototype.scrollIntoView ??= (() => {}) as never
  mocks.mutate.mockReset()
  mocks.linkTicketToConversationFn.mockReset()
  mocks.listTicketTypesFn.mockReset()
  mocks.listTicketTypesFn.mockResolvedValue([bugType, refundType, outageType])
})

afterEach(cleanup)

describe('CreateTicketDialog — Phase 4 type picker', () => {
  it('preselects the customer-category default type and renders its fields', async () => {
    renderDialog()
    // The default type leads: its name in the trigger, its field set below.
    expect(await screen.findByText('Bug report')).toBeInTheDocument()
    expect(await screen.findByText('Steps to reproduce')).toBeInTheDocument()
    expect(screen.queryByText('Order id')).toBeNull()
  })

  it('swapping types swaps the dynamic field set', async () => {
    renderDialog()
    const trigger = await screen.findByRole('combobox')
    expect(await screen.findByText('Steps to reproduce')).toBeInTheDocument()

    await pickSelectOption(trigger, 'Refund request')
    expect(await screen.findByText('Order id')).toBeInTheDocument()
    expect(screen.queryByText('Steps to reproduce')).toBeNull()
  })

  it('blocks submit on a required type field with an inline error', async () => {
    renderDialog()
    await pickSelectOption(await screen.findByRole('combobox'), 'Refund request')
    fireEvent.change(await screen.findByPlaceholderText('Summarize the request…'), {
      target: { value: 'Refund missing' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create ticket' }))

    expect(await screen.findByText('Order id is required')).toBeInTheDocument()
    expect(mocks.mutate).not.toHaveBeenCalled()
  })

  it('submits with ticketTypeId + validated customAttributes and no bare category', async () => {
    renderDialog()
    await pickSelectOption(await screen.findByRole('combobox'), 'Refund request')
    fireEvent.change(await screen.findByPlaceholderText('Summarize the request…'), {
      target: { value: 'Refund missing' },
    })
    // The type's required text field renders as a plain input under its label.
    const orderInput = (await screen.findByText('Order id')).parentElement!.querySelector('input')!
    fireEvent.change(orderInput, { target: { value: 'A-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create ticket' }))

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))
    const [input] = mocks.mutate.mock.calls[0]
    expect(input).toMatchObject({
      ticketTypeId: 'ticket_type_refund',
      title: 'Refund missing',
      customAttributes: { order_id: 'A-123' },
    })
    // The category is derived server-side from the type — never sent alongside.
    expect(input.type).toBeUndefined()
  })

  it('limits the picker to customer-category types in the from-a-conversation flow', async () => {
    renderDialog({ conversationId: 'conversation_1' as never })
    const trigger = await screen.findByRole('combobox')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(await screen.findByRole('option', { name: /Bug report/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Outage/ })).toBeNull()
  })
})
