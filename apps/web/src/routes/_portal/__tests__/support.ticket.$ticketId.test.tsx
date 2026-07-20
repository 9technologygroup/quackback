// @vitest-environment happy-dom
/**
 * Portal ticket detail (support.ticket.$ticketId) — convergence Phase 2
 * surface coverage:
 *
 *  - B16: a signed-out visitor (e.g. arriving from a reply-notification email
 *    CTA) gets the sign-in gate — the shared auth popover, never a misleading
 *    "Ticket not found"; signing in happens in place (the queries enable on
 *    the same URL).
 *  - READ-THROUGH: a signed-in requester viewing the page fires the mark-read
 *    that writes the pair's SHARED watermark server-side (the conversation's
 *    visitor_last_read_at on a linked pair).
 *  - The union thread renders (a backed ticket's conversation-parented rows
 *    are not the "No replies yet" empty state).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReactNode } from 'react'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IntlProvider } from 'react-intl'

const routeCtx = vi.hoisted(() => ({
  session: null as null | { user: { principalType: string } },
  settings: { featureFlags: { supportTickets: true } },
}))
const openAuthPopover = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({
  createFileRoute:
    () =>
    <T extends object>(options: T) => ({
      ...options,
      useParams: () => ({ ticketId: 'ticket_1' }),
    }),
  useRouteContext: () => routeCtx,
  Navigate: () => null,
  Link: ({ children, ...props }: { children: ReactNode }) => <a {...props}>{children}</a>,
  useNavigate: () => vi.fn(),
}))
vi.mock('@/components/auth/auth-popover-context', () => ({
  useAuthPopoverSafe: () => ({ openAuthPopover }),
}))

const fns = vi.hoisted(() => ({
  getMyTicketFn: vi.fn(),
  getMyTicketThreadFn: vi.fn(),
  getMyTicketWatchStatusFn: vi.fn(),
  getMyTicketStageLabelsFn: vi.fn(),
  replyToMyTicketFn: vi.fn(),
  watchMyTicketFn: vi.fn(),
  unwatchMyTicketFn: vi.fn(),
  markMyTicketReadFn: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/server/functions/tickets', () => fns)

// tiptap is heavy in happy-dom; the gate/read-through assertions don't need a
// real composer.
vi.mock('@/components/ui/rich-text-editor', () => ({
  RichTextEditor: () => null,
  RichTextContent: ({ content }: { content: unknown }) => <div>{JSON.stringify(content)}</div>,
}))
vi.mock('@/lib/client/hooks/use-image-upload', () => ({
  usePortalImageUpload: () => ({ upload: vi.fn() }),
}))

import { Route } from '../support.ticket.$ticketId'

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

const Page = (Route as unknown as { component: React.ComponentType }).component

beforeEach(() => {
  routeCtx.session = null
  fns.getMyTicketFn.mockReset()
  fns.getMyTicketThreadFn.mockReset()
  fns.getMyTicketWatchStatusFn.mockReset()
  fns.getMyTicketStageLabelsFn.mockReset()
  fns.getMyTicketStageLabelsFn.mockResolvedValue({
    received: 'Queued',
    in_progress: 'Being fixed',
    awaiting_requester: 'Waiting on you',
    resolved: 'Done',
  })
  fns.markMyTicketReadFn.mockClear()
  fns.markMyTicketReadFn.mockResolvedValue({ ok: true })
  openAuthPopover.mockClear()
})

afterEach(cleanup)

describe('portal ticket detail — B16 sign-in gate', () => {
  it('a signed-out visitor gets the auth-popover gate, never "Ticket not found"', async () => {
    render(<Page />, { wrapper: wrapper() })

    expect(await screen.findByText('Sign in to view your ticket')).toBeTruthy()
    expect(screen.queryByText('Ticket not found')).toBeNull()
    // The detail queries stay disabled while logged out.
    expect(fns.getMyTicketFn).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /log in/i }))
    expect(openAuthPopover).toHaveBeenCalledWith({ mode: 'login' })
  })

  it('an anonymous (widget-tier) principal is treated as signed-out too', async () => {
    routeCtx.session = { user: { principalType: 'anonymous' } }
    render(<Page />, { wrapper: wrapper() })

    expect(await screen.findByText('Sign in to view your ticket')).toBeTruthy()
    expect(fns.getMyTicketFn).not.toHaveBeenCalled()
  })
})

describe('portal ticket detail — signed-in (read-through + union thread)', () => {
  beforeEach(() => {
    routeCtx.session = { user: { principalType: 'user' } }
    fns.getMyTicketFn.mockResolvedValue({
      id: 'ticket_1',
      title: 'CSV export drops filter columns',
      reference: '#1042',
      stage: { slot: 'in_progress', label: 'In progress' },
      unreadCount: 1,
    })
    fns.getMyTicketThreadFn.mockResolvedValue({
      messages: [
        {
          id: 'm1',
          content: 'Fix queued for tomorrow',
          contentJson: null,
          senderType: 'agent',
          author: { displayName: 'Jo' },
          isAssistant: false,
          attachments: [],
          citations: [],
          conversationId: 'conversation_1',
          ticketId: null,
          createdAt: new Date().toISOString(),
        },
      ],
      hasMore: false,
    })
    fns.getMyTicketWatchStatusFn.mockResolvedValue({ watching: false })
  })

  it('renders the union thread (conversation-parented rows are not the empty state)', async () => {
    render(<Page />, { wrapper: wrapper() })

    expect(await screen.findByText('CSV export drops filter columns')).toBeTruthy()
    expect(await screen.findByText('Fix queued for tomorrow')).toBeTruthy()
    expect(screen.queryByText(/no replies yet/i)).toBeNull()
    expect(screen.queryByText('Sign in to view your ticket')).toBeNull()
  })

  it('fires the shared-watermark mark-read once the thread loads', async () => {
    render(<Page />, { wrapper: wrapper() })

    await screen.findByText('Fix queued for tomorrow')
    await waitFor(() =>
      expect(fns.markMyTicketReadFn).toHaveBeenCalledWith(
        expect.objectContaining({ data: { ticketId: 'ticket_1' } })
      )
    )
  })
})

describe('portal ticket detail — customer-surface polish (B19/B22/B25)', () => {
  beforeEach(() => {
    routeCtx.session = { user: { principalType: 'user' } }
    fns.getMyTicketThreadFn.mockResolvedValue({ messages: [], hasMore: false })
    fns.getMyTicketWatchStatusFn.mockResolvedValue({ watching: false })
  })

  it('B19: the StageTracker renders the workspace-customized stage labels, not the defaults', async () => {
    fns.getMyTicketFn.mockResolvedValue({
      id: 'ticket_1',
      title: 'T',
      reference: '#1',
      stage: { slot: 'in_progress', label: 'In progress', closed: false },
      unreadCount: 0,
    })
    render(<Page />, { wrapper: wrapper() })
    // The customized label for the current stage ("Being fixed"), not the
    // DEFAULT_TICKET_STAGE_LABELS value ("In progress").
    expect(await screen.findByText('Being fixed')).toBeTruthy()
    expect(screen.queryByText('In progress')).toBeNull()
  })

  it('B22: a null-stage closed ticket shows the generic "Closed" tracker state (never the internal status)', async () => {
    fns.getMyTicketFn.mockResolvedValue({
      id: 'ticket_1',
      title: 'T',
      reference: '#1',
      stage: { slot: null, label: null, closed: true },
      unreadCount: 0,
    })
    render(<Page />, { wrapper: wrapper() })
    expect(await screen.findByText('Closed')).toBeTruthy()
  })

  it('B22: a null-stage OPEN ticket (hidden from the requester) still renders no tracker', async () => {
    fns.getMyTicketFn.mockResolvedValue({
      id: 'ticket_1',
      title: 'T',
      reference: '#1',
      stage: { slot: null, label: null, closed: false },
      unreadCount: 0,
    })
    render(<Page />, { wrapper: wrapper() })
    await screen.findByText('T')
    expect(screen.queryByLabelText('Ticket progress')).toBeNull()
  })

  it('B25: a ticket_status_changed system message renders as the localized notice, not a bubble', async () => {
    fns.getMyTicketFn.mockResolvedValue({
      id: 'ticket_1',
      title: 'T',
      reference: '#1',
      stage: { slot: 'resolved', label: 'Done', closed: true },
      unreadCount: 0,
    })
    fns.getMyTicketThreadFn.mockResolvedValue({
      messages: [
        {
          id: 'm1',
          content: 'Status updated to Resolved',
          contentJson: null,
          senderType: 'system',
          author: null,
          isAssistant: false,
          attachments: [],
          citations: [],
          conversationId: null,
          ticketId: 'ticket_1',
          createdAt: new Date().toISOString(),
          systemEvent: { kind: 'ticket_status_changed', stageLabel: 'Resolved' },
        },
      ],
      hasMore: false,
    })
    render(<Page />, { wrapper: wrapper() })
    const notice = await screen.findByRole('status')
    expect(notice.textContent).toBe('Status updated to Resolved')
  })

  it('B25: the generic-close system event renders the localized "Ticket closed" notice', async () => {
    fns.getMyTicketFn.mockResolvedValue({
      id: 'ticket_1',
      title: 'T',
      reference: '#1',
      stage: { slot: null, label: null, closed: true },
      unreadCount: 0,
    })
    fns.getMyTicketThreadFn.mockResolvedValue({
      messages: [
        {
          id: 'm1',
          content: 'Ticket closed',
          contentJson: null,
          senderType: 'system',
          author: null,
          isAssistant: false,
          attachments: [],
          citations: [],
          conversationId: null,
          ticketId: 'ticket_1',
          createdAt: new Date().toISOString(),
          systemEvent: { kind: 'ticket_status_changed', closed: true },
        },
      ],
      hasMore: false,
    })
    render(<Page />, { wrapper: wrapper() })
    const notice = await screen.findByRole('status')
    expect(notice.textContent).toBe('Ticket closed')
  })

  it('B17: the ticket_created system event renders the localized conversion marker with the reference', async () => {
    fns.getMyTicketFn.mockResolvedValue({
      id: 'ticket_1',
      title: 'T',
      reference: '#1',
      stage: { slot: 'received', label: 'Queued', closed: false },
      unreadCount: 0,
    })
    fns.getMyTicketThreadFn.mockResolvedValue({
      messages: [
        {
          id: 'm1',
          content: 'Ticket #42 created from this conversation',
          contentJson: null,
          senderType: 'system',
          author: null,
          isAssistant: false,
          attachments: [],
          citations: [],
          conversationId: 'conversation_1',
          ticketId: null,
          createdAt: new Date().toISOString(),
          systemEvent: { kind: 'ticket_created', ticketReference: '#42' },
        },
      ],
      hasMore: false,
    })
    render(<Page />, { wrapper: wrapper() })
    const notice = await screen.findByRole('status')
    expect(notice.textContent).toBe('Ticket #42 created from this conversation')
  })
})
