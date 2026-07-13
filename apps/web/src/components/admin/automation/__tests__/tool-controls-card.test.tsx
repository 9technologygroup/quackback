// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IntlProvider } from 'react-intl'

const tools = [
  {
    name: 'search_knowledge',
    label: 'Find an answer',
    description: 'Search published help content.',
    risk: 'read' as const,
    supportedModes: ['disabled', 'autonomous'] as const,
    defaultMode: 'autonomous' as const,
  },
  {
    name: 'end_conversation',
    label: 'End conversation',
    description: 'End a resolved conversation.',
    risk: 'write' as const,
    supportedModes: ['disabled', 'approval', 'autonomous'] as const,
    defaultMode: 'approval' as const,
  },
  {
    name: 'external_lookup',
    label: 'External lookup',
    description: 'An unrecognized extension action.',
    risk: 'read' as const,
    supportedModes: ['disabled', 'autonomous'] as const,
    defaultMode: 'disabled' as const,
  },
]
const config = {
  version: 2 as const,
  identity: { name: 'Quinn', avatarUrl: null, showAiLabel: true },
  voice: {
    tone: 'balanced' as const,
    responseLength: 'balanced' as const,
    additionalInstructions: '',
  },
  channels: {},
  toolControls: { end_conversation: 'autonomous' as const },
}

vi.mock('@/lib/server/functions/assistant-guidance', () => ({
  listAssistantToolsFn: vi.fn(async () => tools),
  listGuidanceRulesFn: vi.fn(),
  createGuidanceRuleFn: vi.fn(),
  updateGuidanceRuleFn: vi.fn(),
  deleteGuidanceRuleFn: vi.fn(),
  reorderGuidanceRulesFn: vi.fn(),
}))
vi.mock('@/lib/server/functions/assistant-settings', () => ({
  getAssistantSettingsFn: vi.fn(async () => ({ config, revision: 2, managedFieldPaths: [] })),
  updateAssistantIdentityFn: vi.fn(),
  updateAssistantVoiceFn: vi.fn(),
  updateAssistantChannelsFn: vi.fn(),
  updateAssistantToolControlsFn: vi.fn(),
  updateWidgetAssistantDeploymentFn: vi.fn(),
}))

import { ToolControlsCard } from '../tool-controls-card'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
})
afterEach(cleanup)

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={queryClient}>
        <ToolControlsCard />
      </QueryClientProvider>
    </IntlProvider>
  )
}

describe('ToolControlsCard', () => {
  it('groups actions by customer outcome without Read/Write badges', async () => {
    renderCard()
    expect(await screen.findByText('Answer and understand')).toBeInTheDocument()
    expect(screen.getByText('Update the conversation')).toBeInTheDocument()
    expect(screen.queryByText('External lookup')).not.toBeInTheDocument()
    expect(screen.queryByText('Read')).not.toBeInTheDocument()
    expect(screen.queryByText('Write')).not.toBeInTheDocument()
  })

  it('shows V2 mode labels and an explicit section save', async () => {
    renderCard()
    expect(await screen.findByLabelText('End conversation setting')).toHaveTextContent(
      'Runs automatically'
    )
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  })
})
