// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IntlProvider } from 'react-intl'

const updateChannels = vi.fn()
const config = {
  version: 2 as const,
  identity: { name: 'Quinn', avatarUrl: null, showAiLabel: true },
  voice: {
    tone: 'balanced' as const,
    responseLength: 'balanced' as const,
    additionalInstructions: '',
  },
  channels: { widget: { additionalInstructions: 'Keep replies concise.' } },
  toolControls: {},
}

vi.mock('@/lib/server/functions/assistant-settings', () => ({
  getAssistantSettingsFn: vi.fn(async () => ({ config, revision: 4, managedFieldPaths: [] })),
  updateAssistantIdentityFn: vi.fn(),
  updateAssistantVoiceFn: vi.fn(),
  updateAssistantChannelsFn: (input: { data: unknown }) => updateChannels(input),
  updateAssistantToolControlsFn: vi.fn(),
  updateWidgetAssistantDeploymentFn: vi.fn(),
}))

import { ChannelInstructionsCard } from '../surface-instructions-card'

afterEach(cleanup)

it('loads V2 Web widget instructions and requires explicit save', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={queryClient}>
        <ChannelInstructionsCard />
      </QueryClientProvider>
    </IntlProvider>
  )
  expect(await screen.findByRole('heading', { name: 'Channel guidance' })).toBeInTheDocument()
  const field = await screen.findByDisplayValue('Keep replies concise.')
  fireEvent.change(field, { target: { value: 'Use short paragraphs.' } })
  expect(updateChannels).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
})
