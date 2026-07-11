// @vitest-environment happy-dom
/**
 * <SuggestedReplyCard>: Quinn's proactive suggested-reply card
 * (QUINN-PROACTIVE-SUGGESTIONS-SPEC.md). Covers the gate (flag off renders
 * nothing), the spend gates between mounting and generating (the dwell
 * timer, the hidden-tab hold, the composer-text defer), the skip/error/done
 * streaming outcomes, the Insert seam (incl. the internal-source leak-gate
 * confirm), Dismiss, the quiet "Ask Copilot" link, and the shown-once log
 * across a remount (the card-level view of the store's cache dedup). Store
 * internals (cache keying, 409 mapping, superseded-run aborts) are pinned in
 * suggested-reply-store.test.ts, not re-pinned here.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ConversationId, ConversationMessageId } from '@quackback/ids'
import { SUGGEST_EVENTS } from '@/lib/shared/assistant/copilot-contract'
import { sseFrame, streamOf, stubStreamingFetch } from '@/test/sse'
import {
  ensureSuggestion,
  getSuggestionEntry,
  resetSuggestionStoreForTests,
  suggestionKey,
} from '@/lib/client/suggested-reply-store'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  // Undo any per-test visibilityState override (see setVisibility).
  delete (document as { visibilityState?: string }).visibilityState
})

const hoisted = vi.hoisted(() => ({
  recordCopilotEvent: vi.fn(),
  routeContext: {
    settings: { featureFlags: { inboxAi: true, assistantProactiveSuggestions: true } },
    principal: { role: 'admin' },
  } as Record<string, unknown>,
}))

vi.mock('@tanstack/react-router', () => ({
  useRouteContext: () => hoisted.routeContext,
}))

vi.mock('@/lib/client/copilot-events', async () => ({
  recordCopilotEvent: hoisted.recordCopilotEvent,
  itemRefBody: (await import('@/test/copilot')).mockItemRefBody,
}))

import { SuggestedReplyCard } from '../suggested-reply-card'

const CONVERSATION_ID = 'conversation_1' as ConversationId
const MESSAGE_ID = 'conversation_message_1' as ConversationMessageId

function doneFrames(overrides: Record<string, unknown> = {}): string {
  return sseFrame(SUGGEST_EVENTS.final, {
    text: 'Here is a suggested reply.',
    citations: [],
    internalSourced: false,
    ...overrides,
  })
}

/** Shadow happy-dom's visibilityState with a controllable own property. */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
}

function renderCard(
  props: Partial<{
    onInsert: (text: string) => void
    onAskCopilot: (() => void) | undefined
    lastCustomerMessageId: string
    shouldDeferSuggestion: () => boolean
    dwellMs: number
  }> = {}
) {
  const onInsert = props.onInsert ?? vi.fn()
  // `'onAskCopilot' in props` so a test can pass an EXPLICIT undefined (the
  // no-Copilot-panel case) distinct from "didn't care" (default spy).
  const onAskCopilot = 'onAskCopilot' in props ? props.onAskCopilot : vi.fn()
  const result = render(
    <SuggestedReplyCard
      item={{ kind: 'conversation', id: CONVERSATION_ID }}
      lastCustomerMessageId={props.lastCustomerMessageId ?? MESSAGE_ID}
      onInsert={onInsert}
      onAskCopilot={onAskCopilot}
      shouldDeferSuggestion={props.shouldDeferSuggestion}
      // Most cases are about post-generation behavior, not the dwell itself —
      // collapse it so they aren't all written against fake timers. The spend
      // gate cases below pass the real default and drive time explicitly.
      dwellMs={props.dwellMs ?? 0}
    />
  )
  return { ...result, onInsert, onAskCopilot }
}

beforeEach(() => {
  resetSuggestionStoreForTests()
  hoisted.recordCopilotEvent.mockClear()
  hoisted.routeContext = {
    settings: { featureFlags: { inboxAi: true, assistantProactiveSuggestions: true } },
    principal: { role: 'admin' },
  }
})

describe('gating', () => {
  it('renders nothing when assistantProactiveSuggestions is off', () => {
    hoisted.routeContext = {
      settings: { featureFlags: { inboxAi: true, assistantProactiveSuggestions: false } },
      principal: { role: 'admin' },
    }
    stubStreamingFetch(doneFrames())
    const { container } = renderCard()
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when inboxAi (the shared gate) is off', () => {
    hoisted.routeContext = {
      settings: { featureFlags: { inboxAi: false, assistantProactiveSuggestions: true } },
      principal: { role: 'admin' },
    }
    stubStreamingFetch(doneFrames())
    const { container } = renderCard()
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing without copilot.use permission', () => {
    hoisted.routeContext = {
      settings: { featureFlags: { inboxAi: true, assistantProactiveSuggestions: true } },
      principal: { role: 'contributor-without-copilot' },
    }
    stubStreamingFetch(doneFrames())
    const { container } = renderCard()
    expect(container).toBeEmptyDOMElement()
  })
})

describe('spend gates (dwell / visibility / composer)', () => {
  it('does not generate before the dwell elapses; fires after it', async () => {
    vi.useFakeTimers()
    const fetchMock = stubStreamingFetch(doneFrames())
    renderCard({ dwellMs: 800 })

    act(() => vi.advanceTimersByTime(700))
    expect(fetchMock).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(100))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never generates for a card unmounted before the dwell elapses (arrow-keying past)', () => {
    vi.useFakeTimers()
    const fetchMock = stubStreamingFetch(doneFrames())
    const { unmount } = renderCard({ dwellMs: 800 })

    act(() => vi.advanceTimersByTime(400))
    unmount()
    act(() => vi.advanceTimersByTime(2000))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('holds fire in a hidden tab, then generates on becoming visible while still mounted', async () => {
    vi.useFakeTimers()
    const fetchMock = stubStreamingFetch(doneFrames())
    setVisibility('hidden')
    renderCard({ dwellMs: 800 })

    act(() => vi.advanceTimersByTime(2000))
    expect(fetchMock).not.toHaveBeenCalled()

    setVisibility('visible')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never generates when the tab stays hidden and the card unmounts', () => {
    vi.useFakeTimers()
    const fetchMock = stubStreamingFetch(doneFrames())
    setVisibility('hidden')
    const { unmount } = renderCard({ dwellMs: 800 })

    act(() => vi.advanceTimersByTime(2000))
    unmount()
    setVisibility('visible')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips generation when the composer already has text at dwell-fire time (one-shot, no retrigger)', async () => {
    vi.useFakeTimers()
    const fetchMock = stubStreamingFetch(doneFrames())
    let composerHasText = true
    renderCard({ dwellMs: 800, shouldDeferSuggestion: () => composerHasText })

    act(() => vi.advanceTimersByTime(800))
    expect(fetchMock).not.toHaveBeenCalled()

    // Clearing the composer AFTER the dwell fired must not retrigger — the
    // skip is one-shot; only a new customer message (new key) or a fresh
    // mount generates.
    composerHasText = false
    act(() => vi.advanceTimersByTime(5000))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('generates normally when the composer is empty at dwell-fire time', async () => {
    stubStreamingFetch(doneFrames())
    renderCard({ shouldDeferSuggestion: () => false })
    await screen.findByText(/Here is a suggested reply/)
  })
})

describe('streaming outcomes', () => {
  it('shows a subtle loading state, then the streamed answer with actions', async () => {
    stubStreamingFetch(doneFrames())
    renderCard()
    await screen.findByText(/Here is a suggested reply/)
    expect(screen.getByRole('button', { name: 'Insert' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
    expect(screen.getByText('Ask Copilot')).toBeInTheDocument()
  })

  it('renders NOTHING on a skip:true final payload', async () => {
    stubStreamingFetch(doneFrames({ text: '', skip: true }))
    const { container } = renderCard()
    // Wait for the stream to resolve, then assert no card ever appears.
    await waitFor(() => expect(container.textContent).toBe(''))
    expect(screen.queryByRole('button', { name: 'Insert' })).not.toBeInTheDocument()
    expect(hoisted.recordCopilotEvent).not.toHaveBeenCalled()
  })

  it('shows a quiet retry affordance on error, which re-fetches', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        body: streamOf(
          sseFrame(SUGGEST_EVENTS.error, { code: 'boom', message: 'Could not draft it' })
        ),
      } as Response)
      .mockResolvedValueOnce({ ok: true, body: streamOf(doneFrames()) } as Response)
    vi.stubGlobal('fetch', fetchMock)

    renderCard()
    await screen.findByText('Could not draft it')
    await userEvent.click(screen.getByRole('button', { name: /retry/i }))
    await screen.findByText(/Here is a suggested reply/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('logging', () => {
  it('logs suggestion_shown exactly once for a generated card, across a remount', async () => {
    const fetchMock = stubStreamingFetch(doneFrames())
    const { unmount } = renderCard()
    await screen.findByText(/Here is a suggested reply/)
    unmount()
    // Remounting the SAME key (e.g. a re-render/tab switch) reuses the cached
    // generation (no second fetch), and the entry-level shownLogged flag
    // (markSuggestionShown) means the remounted card can't double-log.
    renderCard()
    await screen.findByText(/Here is a suggested reply/)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const shown = hoisted.recordCopilotEvent.mock.calls.filter(
      ([arg]) => arg.eventType === 'suggestion_shown'
    )
    expect(shown).toHaveLength(1)
    expect(shown[0][0]).toEqual({
      item: { conversationId: CONVERSATION_ID },
      eventType: 'suggestion_shown',
    })
  })

  it('a background completion logs nothing until the card actually renders (then once)', async () => {
    // shown = RENDERED: a generation that finishes while the teammate is on a
    // different item (the cross-remount cache keeps it streaming) must not
    // count toward the acceptance-rate denominator until they return and the
    // done card really renders.
    stubStreamingFetch(doneFrames())
    ensureSuggestion(
      suggestionKey(CONVERSATION_ID, MESSAGE_ID),
      { conversationId: CONVERSATION_ID },
      MESSAGE_ID
    )
    await waitFor(() =>
      expect(getSuggestionEntry(suggestionKey(CONVERSATION_ID, MESSAGE_ID))?.status).toBe('done')
    )
    expect(hoisted.recordCopilotEvent).not.toHaveBeenCalled()

    // Returning to the item mounts the card, which renders the cached entry —
    // THAT is the view worth counting, exactly once.
    renderCard()
    await screen.findByText(/Here is a suggested reply/)
    const shown = hoisted.recordCopilotEvent.mock.calls.filter(
      ([arg]) => arg.eventType === 'suggestion_shown'
    )
    expect(shown).toHaveLength(1)
  })
})

describe('insert', () => {
  it('inserts directly and logs suggestion_inserted when not internal-sourced', async () => {
    stubStreamingFetch(doneFrames({ internalSourced: false }))
    const { onInsert } = renderCard()
    await screen.findByText(/Here is a suggested reply/)

    await userEvent.click(screen.getByRole('button', { name: 'Insert' }))

    expect(onInsert).toHaveBeenCalledWith('Here is a suggested reply.')
    expect(hoisted.recordCopilotEvent).toHaveBeenCalledWith({
      item: { conversationId: CONVERSATION_ID },
      eventType: 'suggestion_inserted',
      destination: 'reply',
      answerType: 'draft_reply',
      internalSourced: false,
    })
  })

  it('gates an internal-sourced suggestion behind a confirm before inserting', async () => {
    stubStreamingFetch(doneFrames({ internalSourced: true }))
    const { onInsert } = renderCard()
    await screen.findByText(/Here is a suggested reply/)

    await userEvent.click(screen.getByRole('button', { name: 'Insert' }))
    expect(onInsert).not.toHaveBeenCalled()
    expect(await screen.findByText(/uses internal sources/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /insert anyway/i }))
    expect(onInsert).toHaveBeenCalledWith('Here is a suggested reply.')
    expect(hoisted.recordCopilotEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'suggestion_inserted', internalSourced: true })
    )
  })

  it('cancelling the confirm never inserts', async () => {
    stubStreamingFetch(doneFrames({ internalSourced: true }))
    const { onInsert } = renderCard()
    await screen.findByText(/Here is a suggested reply/)

    await userEvent.click(screen.getByRole('button', { name: 'Insert' }))
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(onInsert).not.toHaveBeenCalled()
    expect(
      hoisted.recordCopilotEvent.mock.calls.some(([a]) => a.eventType === 'suggestion_inserted')
    ).toBe(false)
  })
})

describe('dismiss', () => {
  it('removes the card and logs suggestion_dismissed', async () => {
    stubStreamingFetch(doneFrames())
    renderCard()
    await screen.findByText(/Here is a suggested reply/)

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(screen.queryByText(/Here is a suggested reply/)).not.toBeInTheDocument()
    expect(hoisted.recordCopilotEvent).toHaveBeenCalledWith({
      item: { conversationId: CONVERSATION_ID },
      eventType: 'suggestion_dismissed',
    })
  })

  it('a new lastCustomerMessageId revives a dismissed card', async () => {
    stubStreamingFetch(doneFrames())
    const { rerender } = render(
      <SuggestedReplyCard
        item={{ kind: 'conversation', id: CONVERSATION_ID }}
        lastCustomerMessageId={MESSAGE_ID}
        onInsert={vi.fn()}
        onAskCopilot={vi.fn()}
        dwellMs={0}
      />
    )
    await screen.findByText(/Here is a suggested reply/)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(/Here is a suggested reply/)).not.toBeInTheDocument()

    rerender(
      <SuggestedReplyCard
        item={{ kind: 'conversation', id: CONVERSATION_ID }}
        lastCustomerMessageId={'conversation_message_2' as ConversationMessageId}
        onInsert={vi.fn()}
        onAskCopilot={vi.fn()}
        dwellMs={0}
      />
    )
    await screen.findByText(/Here is a suggested reply/)
  })
})

describe('Ask Copilot', () => {
  it('calls onAskCopilot without inserting or dismissing', async () => {
    stubStreamingFetch(doneFrames())
    const { onAskCopilot, onInsert } = renderCard()
    await screen.findByText(/Here is a suggested reply/)

    await userEvent.click(screen.getByText('Ask Copilot'))

    expect(onAskCopilot).toHaveBeenCalledTimes(1)
    expect(onInsert).not.toHaveBeenCalled()
    expect(screen.getByText(/Here is a suggested reply/)).toBeInTheDocument()
  })

  it('hides the link entirely when no onAskCopilot callback is provided', async () => {
    // The route only passes the callback while the Copilot panel is actually
    // openable (flag/permission gate + the ≥xl viewport that renders it);
    // absent, a visible link would be a dead click.
    stubStreamingFetch(doneFrames())
    renderCard({ onAskCopilot: undefined })
    await screen.findByText(/Here is a suggested reply/)

    expect(screen.queryByText('Ask Copilot')).not.toBeInTheDocument()
    // The rest of the card is unaffected.
    expect(screen.getByRole('button', { name: 'Insert' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  })
})
