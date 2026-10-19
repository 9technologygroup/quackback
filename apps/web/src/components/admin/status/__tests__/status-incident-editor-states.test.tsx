// @vitest-environment happy-dom
/**
 * The incident editor must not spin forever: a failed detail load shows an
 * error with a retry, and an incident that no longer exists (the detail fn
 * returns null) shows "not found". So does a link whose id isn't an incident
 * id at all, rather than an empty modal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

let detail: { data: unknown; isLoading: boolean; isError: boolean; isFetching: boolean }
const refetch = vi.fn()

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: (opts: { queryKey: string[] }) =>
    opts.queryKey.includes('choices') ? { data: undefined } : { ...detail, refetch },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))
// The real URL-modal hook runs (it validates the id); only navigation is stubbed.
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/lib/client/queries/status', () => ({
  statusIncidentQueries: { detail: (id: string) => ({ queryKey: ['status', 'detail', id] }) },
  statusComponentQueries: { choices: () => ({ queryKey: ['status', 'components', 'choices'] }) },
  statusKeys: { components: () => ['status', 'components'] },
}))
vi.mock('@/lib/client/mutations/status', () => ({
  useUpdateStatusIncident: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePostStatusIncidentUpdate: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

import { StatusIncidentModal } from '../status-incident-editor'

const INCIDENT_ID = 'status_incident_01h455vb4pex5vsknk084sn02q'

beforeEach(() => {
  refetch.mockReset()
})
afterEach(cleanup)

describe('StatusIncidentModal load states', () => {
  it('shows an error with a retry when the detail fails to load', () => {
    detail = { data: undefined, isLoading: false, isError: true, isFetching: false }
    render(<StatusIncidentModal incidentId={INCIDENT_ID} />)

    expect(screen.getAllByText("Couldn't load this incident").length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('shows not found when the incident no longer exists', () => {
    detail = { data: null, isLoading: false, isError: false, isFetching: false }
    render(<StatusIncidentModal incidentId={INCIDENT_ID} />)

    expect(screen.getAllByText('Incident not found').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('shows not found, not an empty modal, for a link whose id is not an incident id', () => {
    detail = { data: undefined, isLoading: true, isError: false, isFetching: true }
    render(<StatusIncidentModal incidentId="not-an-id" />)

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getAllByText('Incident not found').length).toBeGreaterThan(0)
    expect(screen.getByText('It may have been deleted, or the link is wrong.')).toBeInTheDocument()
  })
})
