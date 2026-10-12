// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    children,
    ...rest
  }: {
    to: string
    search?: { id?: string }
    children: ReactNode
    [key: string]: unknown
  }) => (
    <a href={search?.id ? `${to}?id=${search.id}` : to} {...(rest as object)}>
      {children}
    </a>
  ),
}))
vi.mock('@/lib/server/functions/approval-counts', () => ({
  getRailCountsFn: async () => {
    throw new Error('Home reads the answer the layout warmed')
  },
}))
vi.mock('@/lib/server/functions/approvals', () => ({
  getApprovalFn: vi.fn(),
  listApprovalsFn: vi.fn(),
}))
vi.mock('@/lib/client/hooks/use-notifications-queries', () => ({
  unreadCountQuery: () => ({ queryKey: ['notifications', 'unread'], queryFn: async () => 0 }),
}))

const { WaitingOnYou } = await import('../waiting-on-you')
const { approvalKeys } = await import('@/lib/client/queries/approvals')

function waitingRequest(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    summary: `Request ${id}`,
    risk: 'medium',
    requestedByName: 'Zapier key',
    onBehalfOfName: 'James Morton',
    proposedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    ...overrides,
  }
}

function renderHome(waiting: { count: number; latest: unknown[] }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(approvalKeys.waiting(), waiting)
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" defaultLocale="en" messages={{}}>
        <WaitingOnYou />
      </IntlProvider>
    </QueryClientProvider>
  )
}

afterEach(cleanup)

describe('WaitingOnYou', () => {
  it('shows nothing while nothing waits', () => {
    const { container } = renderHome({ count: 0, latest: [] })
    expect(container).toBeEmptyDOMElement()
  })

  it('lists the newest waiting requests with risk, who asked for whom and age', () => {
    renderHome({
      count: 5,
      latest: [
        waitingRequest('assistant_action_1', { risk: 'high' }),
        waitingRequest('assistant_action_2', {
          requestedByName: 'Zapier key',
          onBehalfOfName: null,
        }),
        waitingRequest('assistant_action_3'),
      ],
    })
    const section = screen.getByRole('region', { name: 'Waiting on you' })
    expect(within(section).getByRole('link', { name: 'Approvals' })).toHaveAttribute(
      'href',
      '/admin/approvals'
    )
    const rows = within(section).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    const first = within(rows[0]!).getByRole('link')
    expect(first).toHaveAttribute('href', '/admin/approvals?id=assistant_action_1')
    expect(first).toHaveTextContent('High')
    expect(first).toHaveTextContent('Request assistant_action_1')
    expect(first).toHaveTextContent('Zapier key for James Morton · 4m')
    expect(within(rows[1]!).getByRole('link')).toHaveTextContent('Zapier key · 4m')
  })

  it('gives a phone row to the title, with who asked on a line below it', () => {
    renderHome({ count: 1, latest: [waitingRequest('assistant_action_1')] })
    const title = screen.getByText('Request assistant_action_1')
    const meta = screen.getByText('Zapier key for James Morton · 4m')
    // Stacked below the small breakpoint, side by side from it.
    expect(title.parentElement).toBe(meta.parentElement)
    expect(title.parentElement!.className.split(' ')).toContain('sm:flex')
    expect(meta.className.split(' ')).toContain('block')
    expect(meta.className).not.toMatch(/(^| )max-w-/)
  })
})
