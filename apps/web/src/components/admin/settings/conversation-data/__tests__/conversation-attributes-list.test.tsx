// @vitest-environment happy-dom
/**
 * Smoke coverage for the conversation attributes registry manager: the row
 * list renders per definition from listConversationAttributesFn (including
 * the AI badge for aiDetect-enabled definitions), and the editor dialog gates
 * the AI-detect section to select-type attributes, wires aiDetect/
 * detectOnClose into the create/update payloads, and surfaces the "Other"
 * fallback hint when no option looks like a catch-all.
 *
 * Radix Select relies on pointer-capture/layout APIs happy-dom doesn't
 * implement, so `@/components/ui/select` is swapped for a native
 * <select>/<option> pair here — the same pattern condition-editor.test.tsx /
 * import-wizard.test.tsx use.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { ReactElement } from 'react'
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const FIXTURE_ATTRIBUTES = [
  {
    id: 'conversation_attribute_1',
    key: 'issue_type',
    label: 'Issue type',
    description: 'What kind of issue this is.',
    fieldType: 'select',
    options: [
      { id: 'opt_1', label: 'Billing', description: null },
      { id: 'opt_2', label: 'Bug', description: null },
    ],
    requiredToClose: false,
    sourceHint: null,
    aiDetect: true,
    detectOnClose: true,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'conversation_attribute_2',
    key: 'severity',
    label: 'Severity',
    description: null,
    fieldType: 'text',
    options: null,
    requiredToClose: false,
    sourceHint: null,
    aiDetect: false,
    detectOnClose: false,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
]

const hoisted = vi.hoisted(() => ({
  listConversationAttributesFn: vi.fn(),
  createConversationAttributeFn: vi.fn(),
  updateConversationAttributeFn: vi.fn(),
  archiveConversationAttributeFn: vi.fn(),
  restoreConversationAttributeFn: vi.fn(),
}))

vi.mock('@/lib/server/functions/conversation-attributes', () => ({
  listConversationAttributesFn: hoisted.listConversationAttributesFn,
  createConversationAttributeFn: hoisted.createConversationAttributeFn,
  updateConversationAttributeFn: hoisted.updateConversationAttributeFn,
  archiveConversationAttributeFn: hoisted.archiveConversationAttributeFn,
  restoreConversationAttributeFn: hoisted.restoreConversationAttributeFn,
}))

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectLabel: ({ children }: { children: React.ReactNode }) => (
    <option disabled>{children}</option>
  ),
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}))

import { ConversationAttributesList } from '../conversation-attributes-list'

afterEach(cleanup)

function renderWithClient(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

/** The Type <select> is the first native select rendered in the form dialog. */
function typeSelect(): HTMLSelectElement {
  return document.querySelectorAll('select')[0] as HTMLSelectElement
}

async function openCreateDialog() {
  const user = userEvent.setup()
  renderWithClient(<ConversationAttributesList />)
  await user.click(await screen.findByRole('button', { name: /new attribute/i }))
  return user
}

describe('ConversationAttributesList', () => {
  it('renders a row per definition from listConversationAttributesFn', async () => {
    hoisted.listConversationAttributesFn.mockResolvedValue(FIXTURE_ATTRIBUTES)
    renderWithClient(<ConversationAttributesList />)
    expect(await screen.findByText('Issue type')).toBeInTheDocument()
    expect(screen.getByText('Severity')).toBeInTheDocument()
  })

  it('shows an AI badge only for aiDetect-enabled definitions', async () => {
    hoisted.listConversationAttributesFn.mockResolvedValue(FIXTURE_ATTRIBUTES)
    renderWithClient(<ConversationAttributesList />)

    const issueTypeRow = (await screen.findByText('Issue type')).closest(
      '.flex.items-center.gap-4'
    ) as HTMLElement
    expect(within(issueTypeRow).getByText('AI')).toBeInTheDocument()

    const severityRow = screen
      .getByText('Severity')
      .closest('.flex.items-center.gap-4') as HTMLElement
    expect(within(severityRow).queryByText('AI')).not.toBeInTheDocument()
  })

  it('gates the AI-detect section to select-type attributes in the create dialog', async () => {
    hoisted.listConversationAttributesFn.mockResolvedValue([])
    const user = await openCreateDialog()
    expect(screen.queryByText('Let AI detect this attribute')).not.toBeInTheDocument()

    fireEvent.change(typeSelect(), { target: { value: 'select' } })

    expect(await screen.findByText('Let AI detect this attribute')).toBeInTheDocument()
    expect(
      screen.getByText('Quinn classifies conversations it participates in.')
    ).toBeInTheDocument()
    void user
  })

  it('reveals the detect-on-close switch only once AI detect is enabled', async () => {
    hoisted.listConversationAttributesFn.mockResolvedValue([])
    const user = await openCreateDialog()
    fireEvent.change(typeSelect(), { target: { value: 'select' } })
    await screen.findByText('Let AI detect this attribute')

    expect(screen.queryByText('Re-check on close')).not.toBeInTheDocument()

    await user.click(screen.getAllByRole('switch')[0]) // AI detect switch

    expect(await screen.findByText('Re-check on close')).toBeInTheDocument()
  })

  it('shows a dismissable "Other" fallback hint when no option looks like a catch-all', async () => {
    hoisted.listConversationAttributesFn.mockResolvedValue([])
    const user = await openCreateDialog()
    fireEvent.change(typeSelect(), { target: { value: 'select' } })
    await screen.findByText('Let AI detect this attribute')
    await user.click(screen.getAllByRole('switch')[0]) // enable AI detect

    await user.click(screen.getByRole('button', { name: /add option/i }))
    await user.type(screen.getByPlaceholderText('Option label'), 'Billing')

    expect(await screen.findByText(/consider adding an "other"/i)).toBeInTheDocument()

    await user.click(screen.getByTitle('Dismiss'))
    expect(screen.queryByText(/consider adding an "other"/i)).not.toBeInTheDocument()
  })

  it('skips the "Other" hint once an option label matches the fallback pattern', async () => {
    hoisted.listConversationAttributesFn.mockResolvedValue([])
    const user = await openCreateDialog()
    fireEvent.change(typeSelect(), { target: { value: 'select' } })
    await screen.findByText('Let AI detect this attribute')
    await user.click(screen.getAllByRole('switch')[0]) // enable AI detect

    await user.click(screen.getByRole('button', { name: /add option/i }))
    await user.type(screen.getByPlaceholderText('Option label'), 'Other')

    expect(screen.queryByText(/consider adding an "other"/i)).not.toBeInTheDocument()
  })

  it('wires aiDetect and detectOnClose into the create mutation payload', async () => {
    hoisted.listConversationAttributesFn.mockResolvedValue([])
    hoisted.createConversationAttributeFn.mockResolvedValue({})
    const user = await openCreateDialog()

    await user.type(screen.getByLabelText('Key'), 'issue_type')
    await user.type(screen.getByLabelText('Display label'), 'Issue type')

    fireEvent.change(typeSelect(), { target: { value: 'select' } })
    await screen.findByText('Let AI detect this attribute')
    await user.click(screen.getByRole('button', { name: /add option/i }))
    await user.type(screen.getByPlaceholderText('Option label'), 'Billing')

    await user.click(screen.getAllByRole('switch')[0]) // AI detect on
    await screen.findByText('Re-check on close')
    await user.click(screen.getAllByRole('switch')[1]) // Re-check on close on

    await user.click(screen.getByRole('button', { name: /create attribute/i }))

    expect(hoisted.createConversationAttributeFn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ aiDetect: true, detectOnClose: true }),
      })
    )
  })

  it('does not send aiDetect for non-select attributes', async () => {
    hoisted.listConversationAttributesFn.mockResolvedValue([])
    hoisted.createConversationAttributeFn.mockResolvedValue({})
    const user = await openCreateDialog()

    await user.type(screen.getByLabelText('Key'), 'severity')
    await user.type(screen.getByLabelText('Display label'), 'Severity')
    // Default type is Text — no AI section is reachable.
    await user.click(screen.getByRole('button', { name: /create attribute/i }))

    expect(hoisted.createConversationAttributeFn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ aiDetect: false, detectOnClose: false }),
      })
    )
  })
})
