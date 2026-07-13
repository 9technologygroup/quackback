// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IntlProvider } from 'react-intl'

const config = {
  version: 2 as const,
  identity: { name: 'Quinn', avatarUrl: null, showAiLabel: true },
  voice: {
    tone: 'balanced' as const,
    responseLength: 'balanced' as const,
    additionalInstructions: 'Use UK English.',
  },
  channels: {},
  toolControls: {},
}

vi.mock('@/lib/server/functions/assistant-settings', () => ({
  getAssistantSettingsFn: vi.fn(async () => ({ config, revision: 2, managedFieldPaths: [] })),
  updateAssistantIdentityFn: vi.fn(),
  updateAssistantVoiceFn: vi.fn(),
  updateAssistantChannelsFn: vi.fn(),
  updateAssistantToolControlsFn: vi.fn(),
  updateWidgetAssistantDeploymentFn: vi.fn(),
}))

import { AdditionalInstructionsCard } from '../additional-instructions-card'

afterEach(cleanup)

it('presents writing guidelines with an accessible field label', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={queryClient}>
        <AdditionalInstructionsCard />
      </QueryClientProvider>
    </IntlProvider>
  )

  expect(await screen.findByRole('heading', { name: 'Writing guidelines' })).toBeInTheDocument()
  expect(
    await screen.findByRole('textbox', { name: 'Guidelines used in every response' })
  ).toHaveValue('Use UK English.')
})
