// @vitest-environment happy-dom
/**
 * Smoke coverage for the Copilot usage card: the MetricTile headline row,
 * the per-teammate leaderboard, the per-kind transform breakdown, and the
 * actions funnel from getCopilotUsageMetricsFn (mocked), including the
 * zero-state before any data loads.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { ReactElement } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const METRICS = {
  totalQuestions: 42,
  totalTransforms: 7,
  transformsByKind: [
    { transform: 'my_tone', count: 5 },
    { transform: 'more_friendly', count: 2 },
  ],
  totalSummaries: 3,
  actionsProposed: 4,
  actionsApproved: 2,
  actionsRejected: 1,
  actionsExpired: 1,
  approvalRate: 50,
  perTeammate: [
    { principalId: 'principal_1', displayName: 'Alice', questions: 30 },
    { principalId: 'principal_2', displayName: null, questions: 12 },
  ],
}

const hoisted = vi.hoisted(() => ({
  getCopilotUsageMetricsFn: vi.fn(),
}))

vi.mock('@/lib/server/functions/assistant-copilot-analytics', () => ({
  getCopilotUsageMetricsFn: hoisted.getCopilotUsageMetricsFn,
}))

import { CopilotUsageCard } from '../copilot-usage-card'

afterEach(cleanup)

function renderWithClient(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('CopilotUsageCard', () => {
  it('mounts with no required props', () => {
    hoisted.getCopilotUsageMetricsFn.mockResolvedValue(METRICS)
    expect(() => renderWithClient(<CopilotUsageCard />)).not.toThrow()
  })

  it('renders the headline metric tiles', async () => {
    hoisted.getCopilotUsageMetricsFn.mockResolvedValue(METRICS)
    renderWithClient(<CopilotUsageCard />)

    expect(await screen.findByText('42')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
  })

  it('renders the per-teammate leaderboard, falling back for a missing display name', async () => {
    hoisted.getCopilotUsageMetricsFn.mockResolvedValue(METRICS)
    renderWithClient(<CopilotUsageCard />)

    expect(await screen.findByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('30')).toBeInTheDocument()
    expect(screen.getByText('Unknown teammate')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
  })

  it('renders the per-kind transform breakdown with a friendly label', async () => {
    hoisted.getCopilotUsageMetricsFn.mockResolvedValue(METRICS)
    renderWithClient(<CopilotUsageCard />)

    expect(await screen.findByText('My tone')).toBeInTheDocument()
    expect(screen.getByText('More friendly')).toBeInTheDocument()
  })

  it('renders the actions funnel', async () => {
    hoisted.getCopilotUsageMetricsFn.mockResolvedValue(METRICS)
    renderWithClient(<CopilotUsageCard />)

    expect(await screen.findByText('Proposed')).toBeInTheDocument()
    expect(screen.getByText('Approved')).toBeInTheDocument()
    expect(screen.getByText('Rejected')).toBeInTheDocument()
    expect(screen.getByText('Expired')).toBeInTheDocument()
  })

  it('shows a zero-state before data loads', () => {
    hoisted.getCopilotUsageMetricsFn.mockResolvedValue(METRICS)
    renderWithClient(<CopilotUsageCard />)

    // Headline tiles render the placeholder dash while the query is pending.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('shows an empty state when there are no Copilot questions for the period', async () => {
    hoisted.getCopilotUsageMetricsFn.mockResolvedValue({
      ...METRICS,
      totalQuestions: 0,
      perTeammate: [],
      transformsByKind: [],
    })
    renderWithClient(<CopilotUsageCard />)

    expect(await screen.findByText(/no copilot questions/i)).toBeInTheDocument()
  })

  it('fetches the last-30-days range', async () => {
    hoisted.getCopilotUsageMetricsFn.mockResolvedValue(METRICS)
    renderWithClient(<CopilotUsageCard />)

    await screen.findByText('42')
    expect(hoisted.getCopilotUsageMetricsFn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          from: expect.any(String),
          to: expect.any(String),
        }),
      })
    )
  })
})
