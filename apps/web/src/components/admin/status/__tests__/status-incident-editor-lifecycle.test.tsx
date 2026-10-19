// @vitest-environment happy-dom
/**
 * The incident editor around publishing and posting: what it says about the
 * publish email, which lifecycle moves it offers, and how a sidebar edit made
 * just before posting lands relative to the post.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { IntlProvider } from 'react-intl'

const INCIDENT_ID = 'status_incident_01h455vb4pex5vsknk084sn02q'
const API = 'status_component_01h455vb4pex5vsknk084sn02b'

function incident(overrides: Record<string, unknown> = {}) {
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
    notifiedAt: '2026-10-10T08:00:01.000Z',
    notifySubscribers: true,
    createdBy: null,
    createdAt: '2026-10-10T08:00:00.000Z',
    updatedAt: '2026-10-10T08:00:00.000Z',
    notifiedSubscriberCount: 12,
    affectedComponents: [{ componentId: API, componentStatus: 'major_outage', name: 'API' }],
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

let detail: ReturnType<typeof incident>
const choices = { groups: [], ungrouped: [{ id: API, name: 'API' }] }
const mockUpdate = vi.fn()
const mockPost = vi.fn()

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: (opts: { queryKey: string[] }) => {
    if (opts.queryKey.includes('choices')) return { data: choices, isLoading: false }
    if (opts.queryKey.includes('templates')) return { data: [] }
    return { data: detail, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() }
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
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
  usePostStatusIncidentUpdate: () => ({ mutateAsync: mockPost, isPending: false }),
}))

import { StatusIncidentModal } from '../status-incident-editor'

function renderEditor() {
  return render(
    <IntlProvider locale="en" defaultLocale="en" onError={() => {}}>
      <StatusIncidentModal incidentId={INCIDENT_ID} />
    </IntlProvider>
  )
}

beforeEach(() => {
  detail = incident()
  mockUpdate.mockReset()
  mockPost.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('incident editor, the publish email', () => {
  it('says subscribers were emailed, with the count, when they were', () => {
    renderEditor()
    expect(screen.getAllByText(/emailed ~12 subscribers/).length).toBeGreaterThan(0)
  })

  it('says they were not when "Email subscribers" was off, though notifiedAt is set', () => {
    // An unticked publish is stamped notified_at so an older version's
    // sweep never sends it; the choice, not the stamp, says what happened.
    detail = incident({ notifySubscribers: false, notifiedSubscriberCount: null })
    renderEditor()

    expect(screen.getAllByText('Published · subscribers not emailed').length).toBeGreaterThan(0)
    expect(screen.queryByText(/emailed ~/)).toBeNull()
    expect(screen.queryByText('Published')).toBeNull()
  })
})

describe('incident editor, a logged past incident', () => {
  it('offers no reopen: only the resolved stage can be posted to', () => {
    detail = incident({
      status: 'resolved',
      resolvedAt: '2026-10-10T09:00:00.000Z',
      backfilled: true,
      notifiedAt: null,
      notifySubscribers: false,
      notifiedSubscriberCount: null,
    })
    renderEditor()

    const stage = (name: string) => screen.getByRole('radio', { name: new RegExp(name) })
    for (const earlier of ['Investigating', 'Identified', 'Monitoring']) {
      expect(stage(earlier)).toBeDisabled()
    }
    expect(stage('Resolved')).toBeEnabled()
    expect(screen.queryByText(/reopen/)).toBeNull()
  })

  it('still offers a reopen on a resolved incident that was live', () => {
    detail = incident({ status: 'resolved', resolvedAt: '2026-10-10T09:00:00.000Z' })
    renderEditor()
    expect(screen.getByRole('radio', { name: /Monitoring/ })).toBeEnabled()
  })
})

describe('incident editor, posting with a sidebar edit still pending', () => {
  // A completed window whose end has passed. Reopening it switches
  // auto-complete off server-side, or the sweep would complete it again.
  const completedWindow = () =>
    incident({
      kind: 'maintenance',
      title: 'Database upgrade',
      status: 'completed',
      impact: 'maintenance',
      scheduledStartAt: '2026-10-10T08:00:00.000Z',
      scheduledEndAt: '2026-10-10T09:00:00.000Z',
      resolvedAt: '2026-10-10T09:00:00.000Z',
      affectedComponents: [{ componentId: API, componentStatus: 'under_maintenance', name: 'API' }],
      updates: [
        {
          id: 'status_incident_update_1',
          status: 'completed',
          body: 'Done.',
          createdAt: '2026-10-10T09:00:00.000Z',
        },
      ],
    })
  type Save = { title: string; autoComplete: boolean }

  function editTitle(value: string) {
    fireEvent.change(screen.getAllByDisplayValue(/^Database upgrade/)[0], { target: { value } })
  }
  function reopenAsVerifying() {
    fireEvent.click(screen.getByRole('radio', { name: /Verifying/ }))
    fireEvent.change(screen.getByPlaceholderText(/What's the latest\?/), {
      target: { value: 'Still checking replicas.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Post update & reopen as Verifying' }))
  }

  it('saves the edit before posting, so it never lands on top of the reopen', async () => {
    vi.useFakeTimers()
    detail = completedWindow()
    const calls: string[] = []
    mockUpdate.mockImplementation(async (input: Save) => {
      calls.push(`save ${input.title}`)
      return { ...detail, title: input.title }
    })
    mockPost.mockImplementation(async () => {
      calls.push('post')
      return { ...detail, status: 'verifying', resolvedAt: null, autoComplete: false }
    })
    renderEditor()

    editTitle('Database upgrade, phase 2')
    reopenAsVerifying()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(calls).toEqual(['save Database upgrade, phase 2', 'post'])
  })

  it('takes the reopen into an edit made while the post is in flight', async () => {
    vi.useFakeTimers()
    detail = completedWindow()
    let finishPost!: () => void
    mockUpdate.mockImplementation(async (input: Save) => ({ ...detail, title: input.title }))
    mockPost.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPost = () =>
            resolve({ ...detail, status: 'verifying', resolvedAt: null, autoComplete: false })
        })
    )
    renderEditor()

    reopenAsVerifying()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    editTitle('Database upgrade, phase 2')
    // The post answers (and the editor renders it) before the edit's
    // debounce runs out.
    await act(async () => {
      finishPost()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockUpdate.mock.calls[0][0]).toMatchObject({
      title: 'Database upgrade, phase 2',
      autoComplete: false,
    })
  })

  it('does not post when the pending edit fails to save, and keeps the update', async () => {
    vi.useFakeTimers()
    detail = completedWindow()
    mockUpdate.mockRejectedValue(new Error('Could not save'))
    renderEditor()

    editTitle('Database upgrade, phase 2')
    reopenAsVerifying()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(mockUpdate).toHaveBeenCalledTimes(1)
    // Posting now would act on the window as the database still has it.
    expect(mockPost).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText(/What's the latest\?/)).toHaveValue(
      'Still checking replicas.'
    )
  })

  it('keeps a window edit made while the post is in flight, on top of the post', async () => {
    const tz = process.env.TZ
    process.env.TZ = 'UTC'
    try {
      vi.useFakeTimers()
      detail = completedWindow()
      let finishPost!: () => void
      mockUpdate.mockImplementation(async (input: Save) => ({ ...detail, title: input.title }))
      mockPost.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishPost = () =>
              resolve({
                ...detail,
                status: 'verifying',
                resolvedAt: null,
                scheduledStartAt: '2026-10-10T07:30:00.000Z',
                scheduledEndAt: '2026-10-10T09:30:00.000Z',
                autoComplete: false,
              })
          })
      )
      renderEditor()

      reopenAsVerifying()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      // The end moved by hand while the post is still on its way.
      const endField = screen.getByText('Scheduled end').parentElement as HTMLElement
      fireEvent.click(within(endField).getByRole('button'))
      const times = document.querySelectorAll<HTMLInputElement>('input[type="time"]')
      fireEvent.change(times[times.length - 1], { target: { value: '11:00' } })
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      await act(async () => {
        finishPost()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })

      const field = (label: string) =>
        (screen.getByText(label).parentElement as HTMLElement).textContent ?? ''
      expect(field('Scheduled end')).toContain('11:00')
      expect(field('Scheduled start')).toContain('07:30')
      expect(mockUpdate).toHaveBeenCalledTimes(1)
      const save = mockUpdate.mock.calls[0][0] as {
        scheduledStartAt: Date
        scheduledEndAt: Date
        autoComplete: boolean
      }
      expect(save.scheduledEndAt.toISOString()).toBe('2026-10-10T11:00:00.000Z')
      expect(save.scheduledStartAt.toISOString()).toBe('2026-10-10T07:30:00.000Z')
      expect(save.autoComplete).toBe(false)
    } finally {
      process.env.TZ = tz
    }
  })
})
