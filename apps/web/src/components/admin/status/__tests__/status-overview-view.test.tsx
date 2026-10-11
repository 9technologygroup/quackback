// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

let overview: unknown
let overviewQuery: Record<string, unknown> = {}
const refetch = vi.fn()
let permissions: string[] = []

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: overview, isLoading: false, refetch, ...overviewQuery }),
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouteContext: ({ select }: { select: (context: unknown) => unknown }) =>
    select({ permissions }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))
vi.mock('@/routes/admin/status', () => ({
  Route: { fullPath: '/admin/status', useSearch: () => ({}) },
}))
vi.mock('@/lib/client/queries/status', () => ({
  statusOverviewQueries: { get: () => ({ queryKey: ['overview'] }) },
}))
vi.mock('@/lib/client/mutations/status', () => ({
  useStartStatusMaintenanceNow: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('../status-report-incident-dialog', () => ({
  ReportIncidentDialog: () => <button>Report incident</button>,
}))
vi.mock('../status-schedule-maintenance-dialog', () => ({
  ScheduleMaintenanceDialog: () => <button>Schedule maintenance</button>,
}))

import { IntlProvider } from 'react-intl'
import { StatusOverviewView } from '../status-overview-view'

const renderOverview = () =>
  render(
    <IntlProvider locale="en" defaultLocale="en" onError={() => {}}>
      <StatusOverviewView />
    </IntlProvider>
  )

function makeOverview(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    topLevelStatus: 'operational',
    activeIncidents: [],
    liveMaintenance: [],
    upcomingMaintenance: [],
    ungroupedComponents: [{ id: 'c1', name: 'Website', status: 'operational' }],
    groups: [],
    uptime90d: 99.5,
    subscribers: { active: 4, newLast7d: 0 },
    incidentsLast30d: 0,
    ...overrides,
  }
}

describe('<StatusOverviewView>', () => {
  beforeEach(() => {
    overview = makeOverview()
    overviewQuery = {}
    refetch.mockReset()
    permissions = ['status_page.publish', 'status_page.manage']
  })

  it('renders the standard page header with its actions', () => {
    const { container } = renderOverview()
    expect(container.querySelector('[data-page-header] h1')?.textContent).toBe('Overview')
    const header = container.querySelector('[data-page-header]') as HTMLElement
    expect(header.textContent).toContain('View public page')
    expect(header.textContent).toContain('Settings')
    expect(header.textContent).toContain('Schedule maintenance')
    expect(header.textContent).toContain('Report incident')
  })

  it('links the public page and the settings from the header', () => {
    renderOverview()
    expect(screen.getByRole('link', { name: /View public page/ }).getAttribute('href')).toBe(
      '/status'
    )
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe(
      '/admin/settings/status'
    )
  })

  it('uses the glossary empty copy and a sentence-case banner label', () => {
    renderOverview()
    expect(screen.getAllByText('No open incidents').length).toBeGreaterThan(0)
    expect(screen.queryByText(/All clear/)).toBeNull()
    const label = screen.getByText('Visitors currently see')
    expect(label.className).not.toContain('uppercase')
  })

  it('hides service groups that have no services', () => {
    overview = makeOverview({
      groups: [
        { id: 'g1', name: 'Infrastructure', components: [] },
        { id: 'g2', name: 'Apps', components: [{ id: 'c2', name: 'API', status: 'operational' }] },
      ],
    })
    renderOverview()
    expect(screen.queryByText('Infrastructure')).toBeNull()
    expect(screen.getByText('Apps')).toBeTruthy()
  })

  it('shows the stats as sentence-case tiles', () => {
    renderOverview()
    const label = screen.getByText('90-day uptime')
    expect(label.className).not.toContain('uppercase')
    expect(screen.getByText('99.50%')).toBeTruthy()
  })

  it('shows a running window as live, and only windows still ahead as upcoming', () => {
    const window = (id: string, title: string, status: string) => ({
      id,
      kind: 'maintenance',
      title,
      status,
      impact: 'maintenance',
      scheduledStartAt: '2026-10-12T14:00:00.000Z',
      scheduledEndAt: '2026-10-12T16:00:00.000Z',
      autoStart: true,
      autoComplete: true,
      startedAt: '2026-10-12T13:00:00.000Z',
      affectedComponents: [{ componentId: 'c1', name: 'Website' }],
      updates: [{ id: `${id}-u`, body: 'Under way.', createdAt: '2026-10-12T13:00:00.000Z' }],
    })
    overview = makeOverview({
      liveMaintenance: [window('m1', 'Database failover', 'in_progress')],
      upcomingMaintenance: [window('m2', 'Network upgrade', 'scheduled')],
    })
    renderOverview()

    const live = screen.getByText('Maintenance in progress').closest('section') as HTMLElement
    expect(within(live).getByText('Database failover')).toBeTruthy()
    expect(within(live).getByText('In progress')).toBeTruthy()
    expect(within(live).getByRole('button', { name: 'Post update' })).toBeTruthy()
    expect(within(live).queryByText('Network upgrade')).toBeNull()

    const upcoming = screen.getByText('Upcoming maintenance').closest('section') as HTMLElement
    expect(within(upcoming).getByText('Network upgrade')).toBeTruthy()
    expect(within(upcoming).queryByText('Database failover')).toBeNull()
    expect(within(upcoming).getByRole('button', { name: 'Start now' })).toBeTruthy()
  })

  it('shows no maintenance cards when no window is open', () => {
    renderOverview()
    expect(screen.queryByText('Maintenance in progress')).toBeNull()
    expect(screen.queryByText('Upcoming maintenance')).toBeNull()
  })

  it('offers a publisher only what it can do: no settings, and no managing services', () => {
    permissions = ['status_page.publish']
    overview = makeOverview({ ungroupedComponents: [], groups: [] })
    const { container } = renderOverview()

    const header = container.querySelector('[data-page-header]') as HTMLElement
    expect(header.textContent).toContain('Report incident')
    expect(header.textContent).toContain('Schedule maintenance')
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull()
    expect(screen.getByText('No services yet')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add a service' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull()
  })

  it('says the overview failed to load, with a retry, instead of an endless skeleton', () => {
    overview = undefined
    overviewQuery = { isError: true, isFetching: false }
    renderOverview()

    expect(screen.getByText("Couldn't load the overview")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('offers to add the first service, without a paragraph', () => {
    overview = makeOverview({ ungroupedComponents: [], groups: [] })
    renderOverview()
    expect(screen.getByText('No services yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add a service' })).toBeTruthy()
    expect(screen.queryByText(/Add the systems you want/)).toBeNull()
  })
})
