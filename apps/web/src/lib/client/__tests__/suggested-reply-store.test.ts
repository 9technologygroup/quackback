// @vitest-environment happy-dom
/**
 * suggested-reply-store: the module-level cache backing the proactive
 * suggested-reply card (QUINN-PROACTIVE-SUGGESTIONS-SPEC.md), now streaming over
 * a per-run ChatClient (TanStack AI's AG-UI protocol). Covers the
 * final/error/skip outcomes read off RUN_FINISHED.result, the FINAL-ONLY
 * invariant (partial chunks ignored), "generate once per key", the store NEVER
 * logging `suggestion_shown` itself (that's the card's on-render event), the
 * 409-staleness -> skip mapping (a `http_409` RUN_ERROR), abort hardening
 * (superseded same-item runs, retry-while-in-flight, late frames after a stop,
 * reset never resurrecting entries), dismiss persistence, retry clearing the
 * cache, and the eviction cap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aguiRun, aguiErrorRun, structuredDeltas, mockStreamingResponse } from '@/test/agui'

const hoisted = vi.hoisted(() => ({ recordCopilotEvent: vi.fn() }))
vi.mock('@/lib/client/copilot-events', () => ({
  recordCopilotEvent: hoisted.recordCopilotEvent,
}))

import {
  dismissSuggestion,
  ensureSuggestion,
  getSuggestionEntry,
  markSuggestionShown,
  resetSuggestionStoreForTests,
  retrySuggestion,
  subscribeSuggestion,
  suggestionKey,
  SUGGESTION_CACHE_MAX,
} from '../suggested-reply-store'

/** A DONE final: the wire shape the server actually sends (RUN_FINISHED.result). */
function doneRun(text = 'Hi', citations: unknown[] = []): string {
  return aguiRun({ result: { text, citations, internalSourced: false } })
}

/** Stub global fetch to a fresh streaming AG-UI response (the same frames) per
 *  call. */
function stubFetch(frames: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => Promise.resolve(mockStreamingResponse(frames)))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Wait until `getSuggestionEntry(key)` satisfies `predicate`. The ChatClient
 *  delivers chunks across setTimeout(0) ticks, so this polls both microtasks
 *  and zero-timers. */
async function waitForEntry(
  key: string,
  predicate: (entry: ReturnType<typeof getSuggestionEntry>) => boolean
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate(getSuggestionEntry(key))) return
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
  throw new Error('waitForEntry timed out')
}

/** Flush pending promise chains/zero-timers a few times. */
async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
}

/** Wait until the ChatClient has dispatched at least `count` fetches (the fetch
 *  is deferred past the client's onResponse tick, unlike the old synchronous
 *  runSseTurn). */
async function waitForFetch(fetchMock: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (fetchMock.mock.calls.length >= count) return
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
  throw new Error('waitForFetch timed out')
}

/** An `ok` response whose body never closes — an in-flight generation. */
function hangingResponse(): Response {
  return { ok: true, body: new ReadableStream<Uint8Array>({ start() {} }) } as Response
}

/** An `ok` response whose body stays open until `push`/`close` are called — for
 *  racing frames against a stop. */
function controlledResponse(): {
  response: Response
  push: (s: string) => void
  close: () => void
} {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller
    },
  })
  const encoder = new TextEncoder()
  return {
    response: { ok: true, body } as Response,
    push: (s: string) => ctrl.enqueue(encoder.encode(s)),
    close: () => ctrl.close(),
  }
}

/** An abort-AWARE fetch stub: the streamed body errors with an AbortError the
 *  moment the request's signal aborts — how a real fetch body behaves — so the
 *  ChatClient's abort path actually fires under test. */
function stubAbortAwareHangingFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal
    return Promise.resolve({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          const fail = () => controller.error(new DOMException('Aborted', 'AbortError'))
          if (signal.aborted) fail()
          else signal.addEventListener('abort', fail)
        },
      }),
    } as Response)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The `signal` the ChatClient's fetch was called with, for abort assertions. */
function fetchSignal(fetchMock: ReturnType<typeof vi.fn>, call: number): AbortSignal {
  return (fetchMock.mock.calls[call][1] as RequestInit).signal as AbortSignal
}

beforeEach(() => {
  resetSuggestionStoreForTests()
  hoisted.recordCopilotEvent.mockClear()
})

afterEach(() => {
  resetSuggestionStoreForTests()
  vi.unstubAllGlobals()
})

describe('suggestionKey', () => {
  it('combines the item id and the customer message id', () => {
    expect(suggestionKey('conversation_1', 'conversation_message_1')).toBe(
      'conversation_1:conversation_message_1'
    )
  })
})

describe('ensureSuggestion', () => {
  it('lands a final payload (RUN_FINISHED.result) as done', async () => {
    stubFetch(
      aguiRun({
        result: {
          text: 'Sure, here is how.',
          citations: [{ type: 'article', id: 'a1', title: 'Guide', url: 'https://x/guide' }],
          internalSourced: false,
        },
      })
    )

    const key = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')

    expect(getSuggestionEntry(key)?.status).toBe('loading')
    await waitForEntry(key, (e) => e?.status === 'done')

    const entry = getSuggestionEntry(key)
    expect(entry?.text).toBe('Sure, here is how.')
    expect(entry?.citations).toHaveLength(1)
    expect(entry?.internalSourced).toBe(false)
  })

  it('ignores partial chunks entirely — only RUN_FINISHED.result transitions state (FINAL-ONLY)', async () => {
    stubFetch(
      aguiRun({
        middle: structuredDeltas({ text: 'a half-drafted guess' }),
        result: {
          text: 'Sure, here is how.',
          citations: [{ type: 'article', id: 'a1', title: 'Guide', url: 'https://x/guide' }],
          internalSourced: false,
        },
      })
    )

    const key = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')

    // The store never surfaces a 'streaming' status — the partial deltas are dropped.
    expect(getSuggestionEntry(key)?.status).toBe('loading')
    await waitForEntry(key, (e) => e?.status === 'done')

    const entry = getSuggestionEntry(key)
    expect(entry?.text).toBe('Sure, here is how.')
    expect(entry?.citations).toHaveLength(1)
  })

  it('renders nothing (a "skip" status) on an honest-miss final payload, and never logs shown', async () => {
    stubFetch(aguiRun({ result: { text: '', citations: [], internalSourced: false, skip: true } }))

    const key = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')
    await waitForEntry(key, (e) => e?.status === 'skip')

    expect(hoisted.recordCopilotEvent).not.toHaveBeenCalled()
  })

  it('treats a non-skip final with no usable text as a skip — never a bare card', async () => {
    stubFetch(aguiRun({ result: { text: '   ', citations: [], internalSourced: false } }))

    const key = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')
    await waitForEntry(key, (e) => e?.status === 'skip')

    expect(hoisted.recordCopilotEvent).not.toHaveBeenCalled()
  })

  it('surfaces an explicit RUN_ERROR', async () => {
    stubFetch(aguiErrorRun({ code: 'boom', message: 'It broke' }))

    const key = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')
    await waitForEntry(key, (e) => e?.status === 'error')

    expect(getSuggestionEntry(key)?.errorMessage).toBe('It broke')
  })

  it('surfaces a generic error when the HTTP response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        body: null,
        json: async () => ({}),
      } as Response)
    )

    const key = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')
    await waitForEntry(key, (e) => e?.status === 'error')

    expect(getSuggestionEntry(key)?.errorMessage).toBe('Something went wrong. Try again.')
  })

  it('maps HTTP 409 (stale lastCustomerMessageId) to a silent skip, never an error card', async () => {
    // The suggest route 409s when the id is no longer the item's latest
    // customer message; aguiFetchClient rewrites it to a `http_409` RUN_ERROR.
    // A Retry would re-send the same stale id (doomed), so the store renders
    // nothing — the newer message is a new key, which regenerates naturally.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        body: null,
        json: async () => ({ error: { message: 'Stale message id' } }),
      } as Response)
    )

    const key = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')
    await waitForEntry(key, (e) => e?.status === 'skip')

    expect(getSuggestionEntry(key)?.errorMessage).toBeUndefined()
    expect(hoisted.recordCopilotEvent).not.toHaveBeenCalled()
  })

  it('never re-fetches for a key that already has a cached/in-flight entry', async () => {
    const fetchMock = stubFetch(doneRun())

    const key = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')
    await waitForEntry(key, (e) => e?.status === 'done')

    ensureSuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')
    ensureSuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never logs suggestion_shown itself — a background completion is not a view', async () => {
    stubFetch(doneRun())

    const key = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')
    await waitForEntry(key, (e) => e?.status === 'done')

    expect(hoisted.recordCopilotEvent).not.toHaveBeenCalled()
  })

  it('a distinct lastCustomerMessageId is a distinct cache key (regenerates)', async () => {
    const fetchMock = stubFetch(doneRun())

    const keyA = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(keyA, { conversationId: 'conversation_1' }, 'conversation_message_1')
    await waitForEntry(keyA, (e) => e?.status === 'done')

    const keyB = suggestionKey('conversation_1', 'conversation_message_2')
    ensureSuggestion(keyB, { conversationId: 'conversation_1' }, 'conversation_message_2')
    await waitForEntry(keyB, (e) => e?.status === 'done')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('aborts a still-streaming run when the SAME item gets a newer customer message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(hangingResponse())
      .mockResolvedValueOnce(mockStreamingResponse(doneRun('Fresh')))
    vi.stubGlobal('fetch', fetchMock)

    const staleKey = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(staleKey, { conversationId: 'conversation_1' }, 'conversation_message_1')
    await waitForFetch(fetchMock, 1)
    expect(fetchSignal(fetchMock, 0).aborted).toBe(false)

    const freshKey = suggestionKey('conversation_1', 'conversation_message_2')
    ensureSuggestion(freshKey, { conversationId: 'conversation_1' }, 'conversation_message_2')

    // The superseded run is stopped and its entry marked terminal (it can never
    // render, but it must never look in-flight either).
    expect(fetchSignal(fetchMock, 0).aborted).toBe(true)
    expect(getSuggestionEntry(staleKey)?.status).toBe('error')

    await waitForEntry(freshKey, (e) => e?.status === 'done')
    expect(getSuggestionEntry(freshKey)?.text).toBe('Fresh')
  })

  it('leaves runs for OTHER items streaming (the cross-remount survival contract)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(hangingResponse())
      .mockResolvedValueOnce(hangingResponse())
    vi.stubGlobal('fetch', fetchMock)

    ensureSuggestion(
      suggestionKey('conversation_1', 'conversation_message_1'),
      { conversationId: 'conversation_1' },
      'conversation_message_1'
    )
    ensureSuggestion(
      suggestionKey('conversation_2', 'conversation_message_9'),
      { conversationId: 'conversation_2' },
      'conversation_message_9'
    )
    await waitForFetch(fetchMock, 2)

    expect(fetchSignal(fetchMock, 0).aborted).toBe(false)
    expect(fetchSignal(fetchMock, 1).aborted).toBe(false)
  })
})

describe('abort hardening', () => {
  it('frames buffered past a stop never flip the superseded entry back to life', async () => {
    const run1 = controlledResponse()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(run1.response)
      .mockResolvedValueOnce(hangingResponse())
    vi.stubGlobal('fetch', fetchMock)

    const staleKey = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(staleKey, { conversationId: 'conversation_1' }, 'conversation_message_1')
    await waitForFetch(fetchMock, 1)
    await flush(2) // let run 1's reader attach

    // Supersede run 1 with a newer customer message on the same item.
    ensureSuggestion(
      suggestionKey('conversation_1', 'conversation_message_2'),
      { conversationId: 'conversation_1' },
      'conversation_message_2'
    )
    expect(fetchSignal(fetchMock, 0).aborted).toBe(true)
    expect(getSuggestionEntry(staleKey)?.status).toBe('error')

    // Run 1's stream now delivers a full final frame anyway.
    run1.push(aguiRun({ result: { text: 'Zombie', citations: [], internalSourced: false } }))
    run1.close()
    await flush()

    // The superseded entry stays terminal — never flipped to done, no events.
    expect(getSuggestionEntry(staleKey)?.status).toBe('error')
    expect(getSuggestionEntry(staleKey)?.text).toBe('')
    expect(hoisted.recordCopilotEvent).not.toHaveBeenCalled()
  })

  it('retrySuggestion aborts a still-in-flight run for the same key — never two concurrent runs', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(hangingResponse())
      .mockResolvedValueOnce(mockStreamingResponse(doneRun('Recovered')))
    vi.stubGlobal('fetch', fetchMock)

    const key = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')
    await waitForFetch(fetchMock, 1)
    expect(fetchSignal(fetchMock, 0).aborted).toBe(false)

    // Retry while the first run is still streaming: the prior run must die, or
    // two live runs would race over one entry.
    retrySuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')

    await waitForFetch(fetchMock, 2)
    expect(fetchSignal(fetchMock, 0).aborted).toBe(true)
    expect(fetchSignal(fetchMock, 1).aborted).toBe(false)

    await waitForEntry(key, (e) => e?.status === 'done')
    expect(getSuggestionEntry(key)?.text).toBe('Recovered')
  })

  it('a test reset never resurrects entries through the abort path', async () => {
    stubAbortAwareHangingFetch()

    const key = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')
    await flush(2) // fetch resolved, reader pending

    resetSuggestionStoreForTests()
    await flush()

    expect(getSuggestionEntry(key)).toBeUndefined()
  })
})

describe('markSuggestionShown', () => {
  it('flips exactly once for a done entry — the card-side shown guard across remounts', async () => {
    stubFetch(doneRun())
    const key = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')
    await waitForEntry(key, (e) => e?.status === 'done')

    expect(markSuggestionShown(key)).toBe(true)
    expect(markSuggestionShown(key)).toBe(false)
  })

  it('never flips for missing, in-flight, error, skip, or dismissed entries', async () => {
    expect(markSuggestionShown(suggestionKey('conversation_x', 'conversation_message_x'))).toBe(
      false
    )

    stubFetch(doneRun())
    const key = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')
    // Still loading: not shown-able yet.
    expect(markSuggestionShown(key)).toBe(false)
    await waitForEntry(key, (e) => e?.status === 'done')

    dismissSuggestion(key)
    expect(markSuggestionShown(key)).toBe(false)
  })
})

describe('eviction cap', () => {
  /** Land `count` DONE entries sequentially (each its own item, so no supersede
   *  aborts), returning their keys oldest-first. */
  async function fillDone(count: number, offset = 0): Promise<string[]> {
    const keys: string[] = []
    for (let i = offset; i < offset + count; i++) {
      const itemId = `conversation_fill_${i}`
      const key = suggestionKey(itemId, 'conversation_message_1')
      ensureSuggestion(key, { conversationId: itemId }, 'conversation_message_1')
      await waitForEntry(key, (e) => e?.status === 'done')
      keys.push(key)
    }
    return keys
  }

  it('evicts the oldest settled entry once the cap is exceeded', async () => {
    stubFetch(doneRun())
    const keys = await fillDone(SUGGESTION_CACHE_MAX)

    expect(getSuggestionEntry(keys[0])).toBeDefined()

    ensureSuggestion(
      suggestionKey('conversation_extra', 'conversation_message_1'),
      { conversationId: 'conversation_extra' },
      'conversation_message_1'
    )
    expect(getSuggestionEntry(keys[0])).toBeUndefined()
    expect(getSuggestionEntry(keys[1])).toBeDefined()
  })

  it('evicts dismissed/error entries before still-renderable ones', async () => {
    stubFetch(doneRun())
    const keys = await fillDone(SUGGESTION_CACHE_MAX)
    dismissSuggestion(keys[10])

    ensureSuggestion(
      suggestionKey('conversation_extra', 'conversation_message_1'),
      { conversationId: 'conversation_extra' },
      'conversation_message_1'
    )

    expect(getSuggestionEntry(keys[10])).toBeUndefined()
    expect(getSuggestionEntry(keys[0])).toBeDefined()
  })

  it('never evicts a listener-attached key (a mounted card) — the next oldest goes instead', async () => {
    stubFetch(doneRun())
    const keys = await fillDone(SUGGESTION_CACHE_MAX)
    const unsubscribe = subscribeSuggestion(keys[0], () => {})

    ensureSuggestion(
      suggestionKey('conversation_extra', 'conversation_message_1'),
      { conversationId: 'conversation_extra' },
      'conversation_message_1'
    )

    expect(getSuggestionEntry(keys[0])).toBeDefined()
    expect(getSuggestionEntry(keys[1])).toBeUndefined()
    unsubscribe()
  })

  it('never evicts an in-flight (loading/streaming) entry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(hangingResponse())
      .mockImplementation(() => Promise.resolve(mockStreamingResponse(doneRun())))
    vi.stubGlobal('fetch', fetchMock)

    const inflightKey = suggestionKey('conversation_hang', 'conversation_message_1')
    ensureSuggestion(inflightKey, { conversationId: 'conversation_hang' }, 'conversation_message_1')
    await waitForFetch(fetchMock, 1)

    const keys = await fillDone(SUGGESTION_CACHE_MAX)

    expect(getSuggestionEntry(inflightKey)?.status).toBe('loading')
    expect(getSuggestionEntry(keys[0])).toBeUndefined()
    expect(getSuggestionEntry(keys[1])).toBeDefined()
  })
})

describe('dismissSuggestion', () => {
  it('marks the entry dismissed in place, notifying subscribers', async () => {
    stubFetch(doneRun())
    const key = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')
    await waitForEntry(key, (e) => e?.status === 'done')

    const listener = vi.fn()
    const unsubscribe = subscribeSuggestion(key, listener)
    dismissSuggestion(key)
    unsubscribe()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(getSuggestionEntry(key)?.dismissed).toBe(true)
    expect(getSuggestionEntry(key)?.text).toBe('Hi')
  })

  it('is a no-op when there is no entry yet for the key', () => {
    const key = suggestionKey('conversation_1', 'conversation_message_9')
    expect(() => dismissSuggestion(key)).not.toThrow()
    expect(getSuggestionEntry(key)).toBeUndefined()
  })
})

describe('retrySuggestion', () => {
  it('discards the cached entry and re-fetches', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockStreamingResponse(aguiErrorRun({ code: 'boom', message: 'Nope' })))
      .mockResolvedValueOnce(mockStreamingResponse(doneRun('Recovered')))
    vi.stubGlobal('fetch', fetchMock)

    const key = suggestionKey('conversation_1', 'conversation_message_1')
    ensureSuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')
    await waitForEntry(key, (e) => e?.status === 'error')

    retrySuggestion(key, { conversationId: 'conversation_1' }, 'conversation_message_1')
    await waitForEntry(key, (e) => e?.status === 'done')

    expect(getSuggestionEntry(key)?.text).toBe('Recovered')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
