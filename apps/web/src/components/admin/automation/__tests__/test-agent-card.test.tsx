// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const config = {
  version: 2 as const,
  identity: { name: 'Ada', avatarUrl: null },
  voice: {
    tone: 'balanced' as const,
    responseLength: 'brief' as const,
    additionalInstructions: '',
  },
}

vi.mock('@/lib/server/functions/assistant-settings', () => ({
  getAssistantSettingsFn: vi.fn(async () => ({ config, revision: 9, managedFieldPaths: [] })),
  updateAssistantIdentityFn: vi.fn(),
  updateAssistantVoiceFn: vi.fn(),
  updateWidgetAssistantDeploymentFn: vi.fn(),
}))

import { TestAgentCard } from '../test-agent-card'

function sse(...frames: Array<{ event: string; data: unknown }>): Response {
  return new Response(
    frames.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )
}

const trace = {
  promptVersion: 'support-agent-v2',
  configRevision: 9,
  role: 'customer_support' as const,
  tone: 'balanced' as const,
  responseLength: 'brief' as const,
  appliedGuidance: [{ id: 'guidance_1', name: 'Refund policy' }],
  toolCalls: [
    { name: 'search_knowledge', outcome: 'read' as const },
    { name: 'create_ticket', outcome: 'simulated' as const },
    { name: 'handoff_to_human', outcome: 'read' as const },
  ],
}

function renderCard(liveChannels?: readonly ('widget' | 'email')[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={queryClient}>
        <TestAgentCard liveChannels={liveChannels} />
      </QueryClientProvider>
    </IntlProvider>
  )
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TestAgentCard', () => {
  it('uses the configured identity, provides four starters, and hides a one-option channel selector', async () => {
    renderCard(['widget'])

    expect(await screen.findByText('Ada')).toBeInTheDocument()
    expect(screen.getByText('AI')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ask a product question' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Report a problem' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ask for a refund' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Request a human' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Channel' })).not.toBeInTheDocument()
    expect(screen.getByText(/No customer is affected/)).toBeInTheDocument()
  })

  it('shows the channel selector only when multiple customer channels are live', async () => {
    renderCard(['widget', 'email'])

    expect(await screen.findByRole('combobox', { name: 'Channel' })).toBeInTheDocument()
  })

  it('streams a turn, announces finalization without announcing tokens, and renders only safe handling detail', async () => {
    vi.mocked(fetch).mockResolvedValue(
      sse(
        { event: 'assistant-test.v2.activity', data: { status: 'searching_kb' } },
        { event: 'assistant-test.v2.delta', data: { text: 'Here is ' } },
        {
          event: 'assistant-test.v2.final',
          data: {
            text: 'Here is the answer. [1]',
            citations: [
              { type: 'article', id: 'article_1', title: 'Refund guide', url: '/hc/refunds' },
            ],
            escalation: { reason: 'explicit_request', mode: 'handoff' },
            trace: {
              ...trace,
              rawPrompt: 'do not render me',
              instructions: 'private instruction',
              reasoning: 'private reasoning',
            },
          },
        }
      )
    )
    renderCard()
    const input = screen.getByRole('textbox', { name: 'Customer message' })
    fireEvent.change(input, { target: { value: 'Can I get a refund?' } })

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText(/Here is the answer/)).toBeInTheDocument()
    const liveRegion = screen.getByRole('status')
    expect(liveRegion).toHaveTextContent('Reply complete.')
    expect(liveRegion).not.toHaveTextContent('Here is the answer')
    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/assistant/test',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          messages: [{ sender: 'customer', content: 'Can I get a refund?' }],
          channel: 'widget',
          agent: 'agent',
        }),
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'How this reply was handled' }))
    expect(screen.getByText('Refund policy')).toBeInTheDocument()
    expect(screen.getAllByText('Refund guide')).toHaveLength(2)
    expect(screen.getByText('Create Ticket')).toBeInTheDocument()
    expect(screen.getByText('Simulated')).toBeInTheDocument()
    expect(screen.getByText('A handoff would occur in a real conversation.')).toBeInTheDocument()
    expect(screen.getByText('The customer asked for a person.')).toBeInTheDocument()
    expect(screen.queryByText('do not render me')).not.toBeInTheDocument()
    expect(screen.queryByText('private instruction')).not.toBeInTheDocument()
    expect(screen.queryByText('private reasoning')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Technical details'))
    expect(screen.getByText('support-agent-v2')).toBeInTheDocument()
    expect(screen.getByText('9')).toBeInTheDocument()
  })

  it('preserves the scenario input on a structured budget failure and retries to a finalized reply', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json(
          {
            error: 'tier_limit_exceeded',
            limit: 'aiTokensPerMonth',
            message: 'Your monthly test budget has been used.',
            current: 500,
            max: 500,
          },
          { status: 402 }
        )
      )
      .mockResolvedValueOnce(
        sse({
          event: 'assistant-test.v2.final',
          data: { text: 'A successful retry.', citations: [], escalation: null, trace },
        })
      )
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Ask for a refund' }))
    const input = screen.getByRole('textbox', { name: 'Customer message' })
    const scenario = 'I would like a refund. What is your refund policy?'
    expect(input).toHaveValue(scenario)

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your monthly test budget has been used.'
    )
    expect(input).toHaveValue(scenario)
    expect(
      screen.getByText('Choose a scenario or ask a question as a customer would.')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('A successful retry.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Reply complete.'))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('restores the input and offers Retry when a stream ends without a final event', async () => {
    vi.mocked(fetch).mockResolvedValue(
      sse({ event: 'assistant-test.v2.delta', data: { text: 'Partial private failure' } })
    )
    renderCard()
    const input = screen.getByRole('textbox', { name: 'Customer message' })
    fireEvent.change(input, { target: { value: 'Please help' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The test run could not be completed. Your message is still here.'
    )
    expect(input).toHaveValue('Please help')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText('Partial private failure')).not.toBeInTheDocument()
  })
})
