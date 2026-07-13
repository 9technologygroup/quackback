// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ConversationId } from '@quackback/ids'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
})

afterEach(cleanup)

const hoisted = vi.hoisted(() => ({
  available: true,
  runTransform: vi.fn(),
  summarizeConversationNowFn: vi.fn(),
  summarizeTicketNowFn: vi.fn(),
  recordCopilotEvent: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/lib/client/hooks/use-copilot-tab-gate', () => ({
  useCopilotTabGate: () => hoisted.available,
}))
vi.mock('@/lib/client/hooks/use-copilot-transform', () => ({
  useCopilotTransform: () => hoisted.runTransform,
}))
vi.mock('@/lib/server/functions/copilot-summary', () => ({
  summarizeConversationNowFn: hoisted.summarizeConversationNowFn,
  summarizeTicketNowFn: hoisted.summarizeTicketNowFn,
}))
vi.mock('@/lib/client/copilot-events', async () => ({
  recordCopilotEvent: hoisted.recordCopilotEvent,
  itemRefBody: (await import('@/test/copilot')).mockItemRefBody,
}))
vi.mock('sonner', () => ({ toast: { error: hoisted.toastError } }))

import { ComposerAiActions, type ComposerMode } from '../composer-ai-actions'

const conversationId = 'conversation_1' as ConversationId

function renderActions({
  activeMode = 'reply',
  reply = 'Short draft.',
  note = '',
}: {
  activeMode?: ComposerMode
  reply?: string
  note?: string
} = {}) {
  const drafts: Record<ComposerMode, string> = { reply, note }
  const restores: Array<ReturnType<typeof vi.fn>> = []
  const onReplaceDraftText = vi.fn((mode: ComposerMode, text: string) => {
    const previous = drafts[mode]
    drafts[mode] = text
    const restore = vi.fn(() => {
      drafts[mode] = previous
    })
    restores.push(restore)
    return restore
  })
  const onInsertNote = vi.fn()

  render(
    <div className="flex flex-wrap">
      <ComposerAiActions
        item={{ kind: 'conversation', id: conversationId }}
        activeMode={activeMode}
        activeDraftText={drafts[activeMode]}
        getDraftText={(mode) => drafts[mode]}
        onReplaceDraftText={onReplaceDraftText}
        onInsertNote={onInsertNote}
      />
    </div>
  )

  return { drafts, restores, onReplaceDraftText, onInsertNote }
}

async function chooseImprove(label: string) {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /improve/i }))
  await user.click(await screen.findByRole('menuitem', { name: label }))
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.available = true
  hoisted.runTransform.mockResolvedValue('Improved draft.')
  hoisted.summarizeConversationNowFn.mockResolvedValue({
    question: 'Refund window',
    bullets: ['Customer asked about refunds.', 'Explained the 30-day window.'],
  })
})

describe('<ComposerAiActions>', () => {
  it('stays hidden when Copilot is unavailable', () => {
    hoisted.available = false
    renderActions()

    expect(screen.queryByRole('button', { name: /improve/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /summarize into note/i })).not.toBeInTheDocument()
  })

  it('improves the visibly active draft and keeps Undo inline', async () => {
    const { onReplaceDraftText, restores } = renderActions({
      activeMode: 'note',
      note: 'Internal draft.',
    })

    await chooseImprove('Rephrase')

    await waitFor(() => {
      expect(onReplaceDraftText).toHaveBeenCalledWith('note', 'Improved draft.')
    })
    expect(hoisted.runTransform).toHaveBeenCalledWith('rephrase', 'Internal draft.')
    expect(screen.getByText('Draft improved.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(restores[0]).toHaveBeenCalled()
  })

  it('never overwrites text entered while Improve is running', async () => {
    let resolveTransform: (value: string) => void = () => {}
    hoisted.runTransform.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTransform = resolve
        })
    )
    const { drafts, onReplaceDraftText } = renderActions()

    await chooseImprove('More concise')
    drafts.reply = 'A newer edit.'
    resolveTransform('Concise draft.')

    expect(
      await screen.findByText('Your reply draft changed while Improve was working.')
    ).toBeInTheDocument()
    expect(onReplaceDraftText).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Use improved draft' }))
    expect(onReplaceDraftText).toHaveBeenCalledWith('reply', 'Concise draft.')
  })

  it('creates a clearly targeted note and records the summary insertion', async () => {
    const { onInsertNote } = renderActions()

    fireEvent.click(screen.getByRole('button', { name: 'Summarize into note' }))

    await waitFor(() => {
      expect(onInsertNote).toHaveBeenCalledWith(
        'Question\nRefund window\n\nSummary\n- Customer asked about refunds.\n- Explained the 30-day window.'
      )
    })
    expect(hoisted.recordCopilotEvent).toHaveBeenCalledWith({
      item: { conversationId },
      eventType: 'summary_inserted',
      destination: 'note',
    })
  })
})
