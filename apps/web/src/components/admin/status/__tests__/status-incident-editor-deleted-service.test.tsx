// @vitest-environment happy-dom
/**
 * A service deleted while an incident's editor is open: the server leaves it
 * out of the incident, so the editor must stop showing it ticked (or every
 * autosave sends it again, to be silently dropped) and say what happened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'

const INCIDENT_ID = 'status_incident_01h455vb4pex5vsknk084sn02q'
const WEBHOOKS = 'status_component_01h455vb4pex5vsknk084sn02a'
const API = 'status_component_01h455vb4pex5vsknk084sn02b'

type Affected = { componentId: string; componentStatus: string; name: string }

function incident(affected: Affected[], overrides: Record<string, unknown> = {}) {
  return {
    id: INCIDENT_ID,
    kind: 'incident',
    title: 'Elevated errors',
    status: 'investigating',
    impact: 'major',
    impactOverride: false,
    scheduledStartAt: null,
    scheduledEndAt: null,
    autoStart: true,
    autoComplete: true,
    startedAt: '2026-10-10T08:00:00.000Z',
    resolvedAt: null,
    backfilled: false,
    notifiedAt: null,
    notifySubscribers: false,
    createdBy: null,
    createdAt: '2026-10-10T08:00:00.000Z',
    updatedAt: '2026-10-10T08:00:00.000Z',
    notifiedSubscriberCount: null,
    affectedComponents: affected,
    updates: [
      {
        id: 'status_incident_update_1',
        status: 'investigating',
        body: 'Looking into it.',
        createdAt: '2026-10-10T08:00:00.000Z',
      },
    ],
    ...overrides,
  }
}

const both: Affected[] = [
  { componentId: WEBHOOKS, componentStatus: 'major_outage', name: 'Webhooks' },
  { componentId: API, componentStatus: 'major_outage', name: 'API' },
]
const apiOnly = both.slice(1)

let detail: ReturnType<typeof incident>
// The picker's list is stale: it still offers the deleted service.
const choices = {
  groups: [],
  ungrouped: [
    { id: WEBHOOKS, name: 'Webhooks' },
    { id: API, name: 'API' },
  ],
}
const mockUpdate = vi.fn()
const refetch = vi.fn()
const invalidateQueries = vi.fn()

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: (opts: { queryKey: string[] }) => {
    if (opts.queryKey.includes('choices')) return { data: choices, isLoading: false }
    if (opts.queryKey.includes('templates')) return { data: [] }
    return { data: detail, isLoading: false, isError: false, isFetching: false, refetch }
  },
  useQueryClient: () => ({ invalidateQueries: invalidateQueries }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/lib/client/queries/status', () => ({
  statusIncidentQueries: { detail: (id: string) => ({ queryKey: ['status', 'detail', id] }) },
  statusComponentQueries: { choices: () => ({ queryKey: ['status', 'components', 'choices'] }) },
  statusTemplateQueries: { list: () => ({ queryKey: ['status', 'templates'] }) },
  statusKeys: { components: () => ['status', 'components'] },
}))
vi.mock('@/lib/client/mutations/status', () => ({
  useUpdateStatusIncident: () => ({ mutateAsync: mockUpdate, isPending: false }),
  usePostStatusIncidentUpdate: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

import { StatusIncidentModal, deletedServicesNotice } from '../status-incident-editor'

function renderEditor() {
  return render(
    <IntlProvider locale="en" defaultLocale="en" onError={() => {}}>
      <StatusIncidentModal incidentId={INCIDENT_ID} />
    </IntlProvider>
  )
}

/** The checkbox on a service's row in the (first) affected-services list. */
function serviceBox(name: string) {
  const row = screen.getAllByText(name)[0].closest('div') as HTMLElement
  return row.querySelector('[role="checkbox"]') as HTMLElement
}

beforeEach(() => {
  detail = incident(both)
  mockUpdate.mockReset()
  refetch.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('incident editor, service deleted elsewhere', () => {
  it('unticks it and says so when a refetch no longer has it, without saving', () => {
    const view = renderEditor()
    expect(serviceBox('Webhooks').getAttribute('aria-checked')).toBe('true')

    detail = incident(apiOnly)
    view.rerender(
      <IntlProvider locale="en" defaultLocale="en" onError={() => {}}>
        <StatusIncidentModal incidentId={INCIDENT_ID} />
      </IntlProvider>
    )

    expect(
      screen.getAllByText('Webhooks was deleted and removed from this incident.').length
    ).toBeGreaterThan(0)
    // The picker reloads, so the deleted service isn't offered again.
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['status', 'components'] })
    expect(serviceBox('Webhooks').getAttribute('aria-checked')).toBe('false')
    expect(serviceBox('API').getAttribute('aria-checked')).toBe('true')
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('unticks it and says so when a save comes back without it', async () => {
    vi.useFakeTimers()
    mockUpdate.mockResolvedValue(incident(apiOnly, { title: 'Elevated errors on the API' }))
    renderEditor()

    const title = screen.getAllByDisplayValue('Elevated errors')[0]
    fireEvent.change(title, { target: { value: 'Elevated errors on the API' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(
      mockUpdate.mock.calls[0][0].affectedComponents.map((c: Affected) => c.componentId)
    ).toEqual([WEBHOOKS, API])
    expect(
      screen.getAllByText('Webhooks was deleted and removed from this incident.').length
    ).toBeGreaterThan(0)
    expect(serviceBox('Webhooks').getAttribute('aria-checked')).toBe('false')
  })
})

describe('deletedServicesNotice', () => {
  it('names the services, or counts the ones it no longer knows', () => {
    expect(deletedServicesNotice(['Webhooks'])).toBe(
      'Webhooks was deleted and removed from this incident.'
    )
    expect(deletedServicesNotice(['Webhooks', 'API'])).toBe(
      'Webhooks and API were deleted and removed from this incident.'
    )
    expect(deletedServicesNotice([undefined])).toBe(
      'A service was deleted and removed from this incident.'
    )
    expect(deletedServicesNotice(['Webhooks', undefined])).toBe(
      '2 services were deleted and removed from this incident.'
    )
  })
})
