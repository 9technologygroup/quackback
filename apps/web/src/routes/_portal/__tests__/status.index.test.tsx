// @vitest-environment happy-dom
/**
 * The public status page's past-incidents section and its gated-page state.
 *
 * - A quiet fortnight says so ("No incidents in the last 14 days") rather
 *   than rendering nothing.
 * - "Incident history" continues after the recent window (the page passes
 *   the window's start), and says when there is nothing older.
 * - A page published for signed-in visitors offers a signed-out visitor a
 *   way in, instead of only "not available".
 * - Signing in on the page shows what the new viewer may see without a
 *   reload.
 * - The RSS feed is offered only where a feed reader is served it: a reader
 *   has no session, so a page for signed-in visitors or segments, or any page
 *   of a private portal, gives it an empty feed.
 * - Headings never skip a level: sections are h2s and the incidents in them
 *   h3s, including the active-incident cards, which lead the page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IntlProvider } from 'react-intl'

const ctx = vi.hoisted(() => ({
  session: null as null | { user: { id?: string; principalType: string } },
  settings: {
    featureFlags: { statusPage: true },
    statusConfig: { enabled: true, audience: 'public', pageDescription: null },
  } as Record<string, unknown>,
  openAuthPopover: vi.fn(),
  getStatusPageFn: vi.fn(),
  listStatusHistoryFn: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute:
    () =>
    <T extends object>(options: T) => ({
      ...options,
      options,
      // The page's own strings (English here, so the defaults serve).
      useLoaderData: () => ({ messages: {} }),
    }),
  notFound: () => new Error('not found'),
  useRouteContext: (opts?: { select?: (context: never) => unknown }) =>
    opts?.select ? opts.select(ctx as never) : ctx,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock('@/components/auth/auth-popover-context', () => ({
  useAuthPopoverSafe: () => ({ openAuthPopover: ctx.openAuthPopover }),
}))
vi.mock('@/lib/server/functions/public-cache', () => ({
  setPublicDocumentCacheHeaders: vi.fn(),
}))
vi.mock('@/lib/server/functions/status', () => ({
  getStatusPageFn: ctx.getStatusPageFn,
  listStatusHistoryFn: ctx.listStatusHistoryFn,
}))
vi.mock('@/lib/server/functions/status-subscriptions', () => ({
  getMyStatusSubscriptionFn: vi.fn(),
  subscribeStatusFn: vi.fn(),
  unsubscribeStatusFn: vi.fn(),
}))

const { Route } = await import('../status.index')
const options = Route as unknown as {
  component: React.ComponentType
  notFoundComponent: React.ComponentType
}

const WINDOW_START = '2026-09-26T12:00:00.000Z'

function pageData(recentIncidents: unknown[] = [], ungroupedComponents: unknown[] = []) {
  return {
    snapshot: {
      topLevel: {
        status: 'operational',
        worstComponentStatus: 'operational',
        activeIncidentCount: 0,
      },
      groups: [],
      ungroupedComponents,
      activeIncidents: [],
      upcomingMaintenance: [],
      recentIncidents,
      recentWindow: { start: WINDOW_START, days: 14 },
    },
    settings: { pageDescription: null, audience: 'public' },
    uptime: [],
  }
}

function renderWith(Component: React.ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" defaultLocale="en">
        <Component />
      </IntlProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  ctx.session = null
  ctx.settings = {
    featureFlags: { statusPage: true },
    statusConfig: { enabled: true, audience: 'public', pageDescription: null },
  }
  ctx.openAuthPopover.mockReset()
  ctx.getStatusPageFn.mockReset().mockResolvedValue(pageData())
  ctx.listStatusHistoryFn
    .mockReset()
    .mockResolvedValue({ items: [], nextCursor: null, hasMore: false })
})
afterEach(cleanup)

describe('past incidents', () => {
  it('says the recent window was quiet instead of showing nothing', async () => {
    renderWith(options.component)
    expect(await screen.findByText('No incidents in the last 14 days.')).toBeInTheDocument()
  })

  it('continues history after the recent window, and says when there is nothing older', async () => {
    renderWith(options.component)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Incident history →' }))
    expect(await screen.findByText('No earlier incidents.')).toBeInTheDocument()
    expect(ctx.listStatusHistoryFn).toHaveBeenCalledWith({
      data: { cursor: undefined, limit: 20, before: WINDOW_START },
    })
  })
})

describe('a page the visitor cannot see', () => {
  it('offers sign-in when the page is for signed-in visitors and this one is signed out', async () => {
    ctx.settings = {
      featureFlags: { statusPage: true },
      statusConfig: { enabled: true, audience: 'authenticated', pageDescription: null },
    }
    window.history.replaceState(null, '', '/status')
    renderWith(options.notFoundComponent)
    expect(screen.getByRole('heading', { name: 'Sign in to view status' })).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }))
    expect(ctx.openAuthPopover).toHaveBeenCalledWith({ mode: 'login', callbackUrl: '/status' })
  })

  it('stays "not available" when signing in would not help', () => {
    // Public audience: the page is unpublished or gone, not gated.
    renderWith(options.notFoundComponent)
    expect(screen.getByRole('heading', { name: 'Status page not available' })).toBeInTheDocument()
    cleanup()

    // Already signed in: signing in again changes nothing.
    ctx.settings = {
      featureFlags: { statusPage: true },
      statusConfig: { enabled: true, audience: 'authenticated', pageDescription: null },
    }
    ctx.session = { user: { principalType: 'user' } }
    renderWith(options.notFoundComponent)
    expect(screen.getByRole('heading', { name: 'Status page not available' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
  })
})

describe('when the viewer changes', () => {
  /** The page, rendered again on demand with the same query cache. */
  function renderPage() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const page = () => (
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" defaultLocale="en">
          <options.component />
        </IntlProvider>
      </QueryClientProvider>
    )
    const { rerender } = render(page())
    return { renderAgain: () => rerender(page()) }
  }

  it('shows the services a visitor may see once they sign in, without a reload', async () => {
    const { renderAgain } = renderPage()
    await screen.findByText('No incidents in the last 14 days.')
    expect(screen.queryByText('Billing')).toBeNull()

    // Billing is restricted to a segment the signed-in visitor is in.
    ctx.getStatusPageFn.mockResolvedValue(
      pageData(
        [],
        [
          {
            id: 'status_component_billing',
            name: 'Billing',
            description: null,
            status: 'operational',
            showUptime: false,
          },
        ]
      )
    )
    ctx.session = { user: { id: 'user_1', principalType: 'user' } }
    renderAgain()

    expect(await screen.findByText('Billing')).toBeInTheDocument()
    expect(ctx.getStatusPageFn).toHaveBeenCalledTimes(2)
  })

  it('does not refetch while the viewer stays the same', async () => {
    const { renderAgain } = renderPage()
    await screen.findByText('No incidents in the last 14 days.')
    renderAgain()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ctx.getStatusPageFn).toHaveBeenCalledTimes(1)
  })
})

describe('the RSS feed', () => {
  it('is offered on a public page', async () => {
    renderWith(options.component)
    expect(await screen.findByRole('link', { name: 'RSS Feed' })).toHaveAttribute(
      'href',
      '/status/feed'
    )
  })

  it('is not offered on a page for signed-in visitors or chosen segments', async () => {
    for (const audience of ['authenticated', 'segments']) {
      ctx.session = { user: { id: 'user_1', principalType: 'user' } }
      ctx.settings = {
        featureFlags: { statusPage: true },
        statusConfig: { enabled: true, audience, pageDescription: null },
      }
      renderWith(options.component)
      await screen.findByText('No incidents in the last 14 days.')
      expect(screen.queryByRole('link', { name: 'RSS Feed' })).toBeNull()
      cleanup()
    }
  })

  it('is not offered inside a private portal, even on a public page', async () => {
    // A signed-in visitor got past the portal; a feed reader does not.
    ctx.session = { user: { id: 'user_1', principalType: 'user' } }
    ctx.settings = {
      featureFlags: { statusPage: true },
      statusConfig: { enabled: true, audience: 'public', pageDescription: null },
      portalConfig: { access: { visibility: 'private' } },
    }
    renderWith(options.component)
    await screen.findByText('No incidents in the last 14 days.')
    expect(screen.queryByRole('link', { name: 'RSS Feed' })).toBeNull()
  })
})

describe('heading order', () => {
  const update = (body: string, createdAt: string) => ({
    id: `update_${body}`,
    status: 'investigating',
    body,
    createdAt,
  })
  const incident = (id: string, title: string, status: string) => ({
    id,
    kind: 'incident',
    title,
    status,
    impact: 'major',
    scheduledStartAt: null,
    scheduledEndAt: null,
    startedAt: '2026-10-09T10:00:00.000Z',
    resolvedAt: null,
    affectedComponents: [],
    updates: [update(title, '2026-10-09T10:00:00.000Z')],
  })

  it('goes from the page title through section h2s to incident h3s, skipping none', async () => {
    ctx.getStatusPageFn.mockResolvedValue({
      ...pageData(),
      snapshot: {
        ...pageData().snapshot,
        activeIncidents: [incident('status_incident_now', 'API errors', 'investigating')],
        upcomingMaintenance: [
          {
            ...incident('status_incident_maint', 'Database upgrade', 'scheduled'),
            kind: 'maintenance',
            impact: 'maintenance',
            scheduledStartAt: '2026-10-12T02:00:00.000Z',
            scheduledEndAt: '2026-10-12T04:00:00.000Z',
          },
        ],
        recentIncidents: [
          {
            date: '2026-10-08',
            incidents: [incident('status_incident_old', 'DNS blip', 'resolved')],
          },
        ],
      },
    })
    ctx.listStatusHistoryFn.mockResolvedValue({
      items: [incident('status_incident_older', 'Login outage', 'resolved')],
      nextCursor: null,
      hasMore: false,
    })
    const { container } = renderWith(options.component)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Incident history →' }))
    await screen.findByRole('heading', { name: 'Login outage' })

    const headings = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => [
      Number(h.tagName[1]),
      h.textContent,
    ])
    expect(headings).toEqual([
      [1, 'Status'],
      [2, 'Active incidents and maintenance'],
      [3, 'API errors'],
      [2, 'Current status by service'],
      [2, 'Scheduled maintenance'],
      [3, 'Database upgrade'],
      [2, 'Past incidents'],
      [3, 'DNS blip'],
      [3, 'Login outage'],
    ])
  })
})
