// @vitest-environment happy-dom
/**
 * The Status admin shows a role what it can use and nothing else. Its reads
 * are gated on status_page.publish (overview, incidents, templates) or
 * status_page.manage (services, subscribers), so a view the role can't read
 * says so instead of sitting on a skeleton while its reads 403, and the nav
 * offers only views the role can open, without fetching counts it can't read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

let permissions: string[] = []
let search: { view?: string; incident?: string } = {}
const queries: Array<{ queryKey: unknown[]; enabled?: boolean }> = []

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouteContext: ({ select }: { select: (context: unknown) => unknown }) =>
    select({ permissions }),
}))
vi.mock('@/routes/admin/status', () => ({
  Route: { fullPath: '/admin/status', useSearch: () => search },
}))
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryKey: unknown[]; enabled?: boolean }) => {
    queries.push(opts)
    return { data: undefined }
  },
}))
vi.mock('@/lib/server/functions/status', () => ({ listStatusIncidentsAdminFn: vi.fn() }))
vi.mock('@/lib/client/queries/status', () => ({
  statusKeys: { incidentList: (p: unknown) => ['status', 'incidents', 'list', p] },
  statusComponentQueries: { list: () => ({ queryKey: ['status', 'components'] }) },
  statusSubscriberQueries: { counts: () => ({ queryKey: ['status', 'subscribers', 'counts'] }) },
}))
vi.mock('../status-overview-view', () => ({ StatusOverviewView: () => <p>overview view</p> }))
vi.mock('../status-incident-list', () => ({ StatusIncidentList: () => <p>incident list</p> }))
vi.mock('../status-components-view', () => ({
  StatusComponentsView: () => <p>services view</p>,
}))
vi.mock('../status-templates-view', () => ({ StatusTemplatesView: () => <p>templates view</p> }))
vi.mock('../status-subscribers-view', () => ({
  StatusSubscribersView: () => <p>subscribers view</p>,
}))
vi.mock('../status-incident-editor', () => ({
  StatusIncidentModal: () => <p>incident editor</p>,
}))

import { StatusAdmin } from '../status-admin'

const PUBLISH = 'status_page.publish'
const MANAGE = 'status_page.manage'

function nav() {
  return screen.getAllByRole('button').map((b) => b.textContent)
}

beforeEach(() => {
  permissions = []
  search = {}
  queries.length = 0
})
afterEach(cleanup)

describe('Status admin access', () => {
  it('shows a role with neither status permission a no-access page, and reads nothing', () => {
    // e.g. a role holding only status.view, the post-status taxonomy permission.
    permissions = ['status.view']
    search = { incident: 'status_incident_01h455vb4pex5vsknk084sn02q' }
    render(<StatusAdmin />)

    expect(screen.getByText("You don't have access to the status page")).toBeTruthy()
    expect(screen.queryByText('overview view')).toBeNull()
    expect(screen.queryByText('incident editor')).toBeNull()
    expect(queries).toEqual([])
  })

  it('offers a publisher the incident views and templates, but not services or subscribers', () => {
    permissions = [PUBLISH]
    render(<StatusAdmin />)

    expect(screen.getByText('overview view')).toBeTruthy()
    const items = nav()
    expect(items).toEqual(
      expect.arrayContaining(['Overview', 'Open incidents', 'Scheduled maintenance', 'Templates'])
    )
    expect(items.some((t) => t?.startsWith('Services'))).toBe(false)
    expect(items.some((t) => t?.startsWith('Subscribers'))).toBe(false)
    // The manage-only counts are never requested.
    const manageReads = queries.filter((q) =>
      ['components', 'subscribers'].includes(String(q.queryKey[1]))
    )
    expect(manageReads.length).toBeGreaterThan(0)
    expect(manageReads.every((q) => q.enabled === false)).toBe(true)
    expect(screen.getByText('incident editor')).toBeTruthy()
  })

  it('shows a publisher a no-access state for a manage-only view, not the view', () => {
    permissions = [PUBLISH]
    search = { view: 'subscribers' }
    render(<StatusAdmin />)

    expect(screen.getByText("You don't have access to this")).toBeTruthy()
    expect(screen.getByText(/status_page\.manage/)).toBeTruthy()
    expect(screen.queryByText('subscribers view')).toBeNull()
  })

  it('opens a role that can only manage the page on its services, without incident reads', () => {
    permissions = [MANAGE]
    render(<StatusAdmin />)

    expect(screen.getByText('services view')).toBeTruthy()
    const items = nav()
    expect(items.some((t) => t?.startsWith('Services'))).toBe(true)
    expect(items.some((t) => t?.startsWith('Overview'))).toBe(false)
    expect(items.some((t) => t?.startsWith('Templates'))).toBe(false)
    const incidentReads = queries.filter((q) => String(q.queryKey[1]) === 'incidents')
    expect(incidentReads.every((q) => q.enabled === false)).toBe(true)
    expect(screen.queryByText('incident editor')).toBeNull()
  })

  it('shows everything to a role with both', () => {
    permissions = [PUBLISH, MANAGE]
    search = { view: 'subscribers' }
    render(<StatusAdmin />)

    expect(screen.getByText('subscribers view')).toBeTruthy()
    expect(queries.every((q) => q.enabled !== false)).toBe(true)
  })
})
