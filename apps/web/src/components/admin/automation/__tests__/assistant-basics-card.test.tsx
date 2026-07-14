// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IntlProvider } from 'react-intl'

const updateVoice = vi.fn()
const config = {
  version: 2 as const,
  identity: { name: 'Quinn', avatarUrl: null },
  voice: {
    tone: 'warm' as const,
    responseLength: 'brief' as const,
    additionalInstructions: 'Use UK English.',
  },
}

vi.mock('@/lib/server/functions/assistant-settings', () => ({
  getAssistantSettingsFn: vi.fn(async () => ({ config, revision: 2, managedFieldPaths: [] })),
  updateAssistantIdentityFn: vi.fn(),
  updateAssistantVoiceFn: (input: { data: unknown }) => updateVoice(input),
  updateWidgetAssistantDeploymentFn: vi.fn(),
}))

import { AssistantVoiceCard } from '../assistant-basics-card'

afterEach(cleanup)

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={queryClient}>
        <AssistantVoiceCard />
      </QueryClientProvider>
    </IntlProvider>
  )
}

describe('AssistantVoiceCard', () => {
  it('renders described semantic radio groups from persisted V2 values', async () => {
    renderCard()
    expect(await screen.findByRole('heading', { name: 'Response style' })).toBeInTheDocument()
    expect(await screen.findByRole('radio', { name: /Warm/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /Brief/ })).toBeChecked()
    expect(screen.getByText('Friendly, empathetic, and conversational.')).toBeInTheDocument()
  })

  it('does not save until Save changes is pressed', async () => {
    updateVoice.mockResolvedValue({
      config: { ...config, voice: { ...config.voice, tone: 'professional' } },
      revision: 3,
    })
    renderCard()
    fireEvent.click(await screen.findByRole('radio', { name: /Professional/ }))
    expect(updateVoice).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateVoice).toHaveBeenCalled())
  })
})
