// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IntlProvider } from 'react-intl'

const rules = [
  {
    id: 'assistant_guidance_1',
    name: 'Refund policy',
    appliesWhen: 'When a customer asks for a refund',
    instruction: 'Explain the 30-day policy.',
    roles: ['customer_support', 'suggested_reply'],
    enabled: true,
    priority: 0,
    createdById: null,
    createdAt: new Date('2026-07-01'),
    updatedAt: new Date('2026-07-01'),
  },
  {
    id: 'assistant_guidance_2',
    name: 'Always be clear',
    appliesWhen: null,
    instruction: 'State the next step.',
    roles: ['customer_support'],
    enabled: false,
    priority: 1,
    createdById: null,
    createdAt: new Date('2026-07-02'),
    updatedAt: new Date('2026-07-02'),
  },
]
let guidanceCharBudget = 4000
const createGuidanceRule = vi.fn()

vi.mock('@/lib/server/functions/assistant-guidance', () => ({
  listGuidanceRulesFn: vi.fn(async () => ({ rules, charBudget: guidanceCharBudget })),
  createGuidanceRuleFn: (input: { data: unknown }) => createGuidanceRule(input),
  updateGuidanceRuleFn: vi.fn(),
  deleteGuidanceRuleFn: vi.fn(),
  reorderGuidanceRulesFn: vi.fn(),
  listAssistantToolsFn: vi.fn(),
}))
vi.mock('@/lib/server/functions/assistant-guidance-stats', () => ({
  getGuidanceRuleStatsFn: vi.fn(async () => ({
    assistant_guidance_1: { applied: 12, lastAppliedAt: new Date('2026-07-10T10:00:00Z') },
  })),
}))

import { GuidanceRulesCard, guidanceRuleMatchesQuery } from '../guidance-rules-card'

afterEach(() => {
  cleanup()
  guidanceCharBudget = 4000
  createGuidanceRule.mockReset()
})

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={queryClient}>
        <GuidanceRulesCard />
      </QueryClientProvider>
    </IntlProvider>
  )
}

describe('guidanceRuleMatchesQuery', () => {
  const rule = {
    name: 'Refund policy',
    appliesWhen: 'When cancelling',
    instruction: 'Explain 30 days',
  } as never
  it('searches name, condition, and instruction', () => {
    expect(guidanceRuleMatchesQuery(rule, 'refund')).toBe(true)
    expect(guidanceRuleMatchesQuery(rule, 'cancelling')).toBe(true)
    expect(guidanceRuleMatchesQuery(rule, '30 days')).toBe(true)
    expect(guidanceRuleMatchesQuery(rule, 'billing owner')).toBe(false)
  })
})

describe('GuidanceRulesCard', () => {
  it('shows conditional versus always-on guidance and honest application stats', async () => {
    renderCard()
    expect(await screen.findByRole('heading', { name: 'Situational guidance' })).toBeInTheDocument()
    expect(await screen.findByText('Refund policy')).toBeInTheDocument()
    expect(screen.getByText('Conditional')).toBeInTheDocument()
    expect(screen.getByText('Always on')).toBeInTheDocument()
    expect(screen.getByText('Applied 12 times')).toBeInTheDocument()
    expect(screen.queryByText(/resolved/i)).not.toBeInTheDocument()
  })

  it('keeps edit, delete, and move controls visible and filters V2 fields', async () => {
    renderCard()
    await screen.findByText('Refund policy')
    expect(screen.getByRole('button', { name: 'Edit Refund policy' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Delete Refund policy' })).toBeVisible()
    fireEvent.change(screen.getByPlaceholderText('Search guidance'), {
      target: { value: 'next step' },
    })
    expect(screen.getByText('Always be clear')).toBeInTheDocument()
    expect(screen.queryByText('Refund policy')).not.toBeInTheDocument()
  })

  it('uses list ordering and prevents enabled guidance from exceeding the budget', async () => {
    guidanceCharBudget = 30
    renderCard()
    fireEvent.click(await screen.findByRole('button', { name: 'Add guidance' }))

    fireEvent.change(screen.getByLabelText('Name this guidance'), {
      target: { value: 'Shipping' },
    })
    fireEvent.change(screen.getByLabelText('What should the AI agent do?'), {
      target: { value: 'Answer.' },
    })

    expect(screen.queryByLabelText('Priority')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Add guidance' }).at(-1)!)
    expect(
      await screen.findByText(
        'Shorten or disable guidance before saving to stay within the budget.'
      )
    ).toBeInTheDocument()
    expect(createGuidanceRule).not.toHaveBeenCalled()
  })
})
