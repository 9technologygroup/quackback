/**
 * Client-side generation cache for Quinn's proactive suggested-reply card
 * (QUINN-PROACTIVE-SUGGESTIONS-SPEC.md). One entry per (item,
 * lastCustomerMessageId): "generate once per state", so re-rendering the
 * card, switching the inbox detail panel's tabs, or navigating away and back
 * to the SAME open conversation never re-spends a generation.
 *
 * Deliberately a plain module-level store (not component state): the hosting
 * component (SuggestedReplyCard, rendered from AgentConversationThread) fully
 * remounts every time the inbox route selects a different item
 * (`key={selectedRef.id}`), which would wipe any per-component cache the
 * instant a teammate opened a different conversation and came back. A
 * `useSyncExternalStore` subscription lets the (re)mounted card observe
 * whatever this store already knows for its key, including an in-flight
 * generation that kept streaming in the background while unmounted.
 *
 * Streaming runs through `runSseTurn` (the same skeleton `useSseTurn` wraps)
 * with a store-owned AbortController per run rather than the hook itself:
 * `useSseTurn`'s controller is scoped to the calling component's lifecycle
 * (aborted on unmount), which is the opposite of what a cross-remount cache
 * needs — a generation in flight when a teammate switches ITEMS should keep
 * running, so it's ready the moment they switch back. The one run worth
 * killing is a superseded one: when the SAME item gets a newer customer
 * message, the old key can never render again, so its stream is aborted
 * (see the in-flight registry below) instead of burning tokens to completion.
 */
import { runSseTurn } from '@/lib/client/hooks/use-sse-turn'
import { extractHttpErrorMessage, GENERIC_ERROR } from '@/lib/client/utils/http-error'
import type { AssistantItemRef } from '@/lib/client/copilot-events'
import {
  SUGGEST_EVENTS,
  type CopilotCitation,
  type SuggestDeltaPayload,
  type SuggestFinalPayload,
  type SuggestErrorPayload,
} from '@/lib/shared/assistant/copilot-contract'

export type SuggestionStatus = 'loading' | 'streaming' | 'done' | 'skip' | 'error'

export interface SuggestionEntry {
  status: SuggestionStatus
  text: string
  citations: CopilotCitation[]
  internalSourced: boolean
  errorMessage?: string
  /** Set by an explicit Dismiss click (suggested-reply-card.tsx). Kept on the
   *  SAME cache entry (rather than a separate set) so it persists across a
   *  full remount of the hosting thread exactly like the rest of the entry —
   *  "dismissed state also keyed by that id" (the spec's wording): a new
   *  customer message means a new key, which has no entry yet, so the card
   *  is revived for free. */
  dismissed?: boolean
  /** Set by `markSuggestionShown` the first time a rendered card observes this
   *  entry — the exactly-once guard for the `suggestion_shown` log. Lives ON
   *  the entry (not a separate set) for the same remount-survival reason as
   *  `dismissed`: a remounted card re-observing a cached entry must not
   *  double-count the acceptance-rate denominator. */
  shownLogged?: boolean
}

const LOADING_ENTRY: SuggestionEntry = {
  status: 'loading',
  text: '',
  citations: [],
  internalSourced: false,
}

/** The terminal-failure entry shape, shared by every error path (HTTP error,
 *  explicit error event, truncated stream, network throw, superseded run). */
function errorEntry(errorMessage: string): SuggestionEntry {
  return { status: 'error', text: '', citations: [], internalSourced: false, errorMessage }
}

type Listener = () => void
type SuggestItemRef = AssistantItemRef

/** Cap on cached generations. Old entries are worthless once the teammate has
 *  moved on (a new customer message is a new key anyway); without a cap a
 *  long inbox session grows the map one paid generation per item visited. */
export const SUGGESTION_CACHE_MAX = 50

const cache = new Map<string, SuggestionEntry>()
const listeners = new Map<string, Set<Listener>>()
/** In-flight runs, keyed by ITEM id (not suggestion key): at most one
 *  generation per item is ever worth having. When `ensureSuggestion` starts a
 *  run for a NEWER customer message on the same item, the older run's key is
 *  permanently stale — nothing will ever render it — so its stream is aborted
 *  rather than left burning tokens to completion (the server honors the
 *  request signal). Runs for OTHER items stay untouched: those keys stay
 *  renderable, and finishing in the background is the whole point of the
 *  cross-remount cache. */
const inflight = new Map<string, { messageId: string; controller: AbortController }>()

/** The one key every entry/listener is keyed by: an item's own id paired with
 *  the customer message driving this generation. A new customer message
 *  yields a new key, which is exactly the "regenerate on a new message" and
 *  "a new message revives a dismissed card" behavior — both fall out of key
 *  identity, nothing bespoke needed. */
export function suggestionKey(itemId: string, lastCustomerMessageId: string): string {
  return `${itemId}:${lastCustomerMessageId}`
}

function itemIdOf(item: SuggestItemRef): string {
  return 'conversationId' in item ? item.conversationId : item.ticketId
}

function notify(key: string): void {
  listeners.get(key)?.forEach((l) => l())
}

function setEntry(key: string, entry: SuggestionEntry): void {
  cache.set(key, entry)
  notify(key)
}

export function getSuggestionEntry(key: string): SuggestionEntry | undefined {
  return cache.get(key)
}

export function subscribeSuggestion(key: string, listener: Listener): () => void {
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(key)
  }
}

/** Flip `key`'s entry to shown-logged, returning true only on the FIRST flip
 *  of a done (generated, non-skip, non-dismissed) entry. The card calls this
 *  on first render of such an entry and fires `suggestion_shown` only when it
 *  returns true — so background completions nobody saw never count, and a
 *  remounted card re-observing the same cache entry can't double-count. An
 *  in-place mutation without notify: the flag never affects rendering, so a
 *  listener wake would be a pointless re-render. */
export function markSuggestionShown(key: string): boolean {
  const entry = cache.get(key)
  if (!entry || entry.status !== 'done' || entry.dismissed || entry.shownLogged) return false
  entry.shownLogged = true
  return true
}

/** Evict beyond-cap entries, oldest-insertion first, in two passes: dismissed/
 *  error entries (already worthless to render or cheap to regenerate) go
 *  before still-renderable done/skip ones. Never evicts an entry that is
 *  in flight (loading/streaming — its run would write into a ghost key) or
 *  one a mounted card is subscribed to. */
function evictOverCap(): void {
  const passes: Array<(entry: SuggestionEntry) => boolean> = [
    (entry) => Boolean(entry.dismissed) || entry.status === 'error',
    () => true,
  ]
  for (const evictable of passes) {
    if (cache.size <= SUGGESTION_CACHE_MAX) return
    for (const [key, entry] of cache) {
      if (listeners.has(key)) continue
      if (entry.status === 'loading' || entry.status === 'streaming') continue
      if (!evictable(entry)) continue
      cache.delete(key)
      if (cache.size <= SUGGESTION_CACHE_MAX) return
    }
  }
}

async function runSuggestion(
  key: string,
  item: SuggestItemRef,
  lastCustomerMessageId: string,
  signal: AbortSignal
): Promise<void> {
  let text = ''
  let finished = false
  await runSseTurn(
    {
      url: '/api/admin/assistant/suggest',
      body: { ...item, lastCustomerMessageId },
      // Every handler/outcome below early-returns once this run's signal has
      // aborted: an abort means a newer run superseded this one (or a test
      // reset tore the store down), and THAT site already owns the entry's
      // terminal state — a frame still buffered in the old stream must not
      // flip the superseded entry back to life.
      handlers: {
        [SUGGEST_EVENTS.delta]: (data) => {
          if (signal.aborted) return
          text += (data as SuggestDeltaPayload).text
          setEntry(key, { status: 'streaming', text, citations: [], internalSourced: false })
        },
        [SUGGEST_EVENTS.final]: (data) => {
          if (signal.aborted) return
          finished = true
          const final = data as SuggestFinalPayload
          const finalText = final.text || text
          if (final.skip || !finalText.trim()) {
            // Honest miss — or a non-skip final that arrived with no usable
            // text (belt to the server's own guard): render nothing rather
            // than a bare card, and never counted as "shown".
            setEntry(key, { status: 'skip', text: '', citations: [], internalSourced: false })
          } else {
            // 'suggestion_shown' is NOT logged here: a final frame landing is
            // not a teammate seeing it (a background completion for an item
            // nobody has open would deflate the acceptance rate). The CARD
            // logs shown on first render of this entry, exactly-once via
            // `markSuggestionShown`.
            setEntry(key, {
              status: 'done',
              text: finalText,
              citations: final.citations,
              internalSourced: final.internalSourced,
            })
          }
        },
        [SUGGEST_EVENTS.error]: (data) => {
          if (signal.aborted) return
          finished = true
          const err = data as SuggestErrorPayload
          setEntry(key, errorEntry(err.message || GENERIC_ERROR))
        },
      },
      onHttpError: async (res) => {
        if (signal.aborted) return
        // 409 CONFLICT is the suggest route's staleness signal: the
        // lastCustomerMessageId this run carried is no longer the item's
        // latest customer message. Not a failure worth a doomed Retry card
        // (retrying re-sends the same stale id) — render nothing; the newer
        // message is a new cache key, which regenerates naturally.
        if (res.status === 409) {
          setEntry(key, { status: 'skip', text: '', citations: [], internalSourced: false })
          return
        }
        setEntry(key, errorEntry(await extractHttpErrorMessage(res)))
      },
      onStreamEnd: () => {
        // Stream ended without a final/error frame — a quiet failure, same
        // retry affordance as an explicit error event.
        if (!finished && !signal.aborted) setEntry(key, errorEntry(GENERIC_ERROR))
      },
      onAbort: () => {
        // Deliberately a no-op: every abort site already owns its terminal
        // entry state (ensureSuggestion writes the stale-key error before
        // aborting a superseded run; a retry's abort is followed by the fresh
        // run's own loading entry; resetSuggestionStoreForTests WANTS the
        // maps empty). Writing here would resurrect entries the abort site
        // just settled or cleared.
      },
      onError: () => {
        if (signal.aborted) return
        setEntry(key, errorEntry(GENERIC_ERROR))
      },
    },
    signal
  )
}

/** Start generation for `key` unless it's already cached or in flight.
 *  `item` is the plain item-ref body fragment (`{conversationId}` or
 *  `{ticketId}`) — needed for the request body and the per-item in-flight
 *  registry. */
export function ensureSuggestion(
  key: string,
  item: SuggestItemRef,
  lastCustomerMessageId: string
): void {
  if (cache.has(key)) return

  // At most one live run per item, so any prior run is aborted
  // UNCONDITIONALLY before starting this one. Two flavors:
  //  - a newer customer message superseding an older run: that run's key can
  //    never render again, so its entry is settled terminal here (the run's
  //    own handlers are abort-inert) and its tokens stop burning;
  //  - a retry of the SAME key (retrySuggestion just deleted the cache
  //    entry): the old run must die too, or its late frames would race the
  //    fresh run over one entry. No stale-key write in that case — the fresh
  //    run's loading entry (below) IS the key's next state.
  // (Runs for other items are keyed separately and keep streaming — see the
  // registry doc above.)
  const itemId = itemIdOf(item)
  const prior = inflight.get(itemId)
  if (prior) {
    if (prior.messageId !== lastCustomerMessageId) {
      setEntry(suggestionKey(itemId, prior.messageId), errorEntry(GENERIC_ERROR))
    }
    prior.controller.abort()
    inflight.delete(itemId)
  }

  setEntry(key, LOADING_ENTRY)
  evictOverCap()
  const controller = new AbortController()
  inflight.set(itemId, { messageId: lastCustomerMessageId, controller })
  void runSuggestion(key, item, lastCustomerMessageId, controller.signal).finally(() => {
    if (inflight.get(itemId)?.controller === controller) inflight.delete(itemId)
  })
}

/** Discard `key`'s cached/in-flight state and start over — the card's quiet
 *  retry affordance after an error. */
export function retrySuggestion(
  key: string,
  item: SuggestItemRef,
  lastCustomerMessageId: string
): void {
  cache.delete(key)
  ensureSuggestion(key, item, lastCustomerMessageId)
}

/** Mark `key`'s entry dismissed (Dismiss button). A no-op if generation
 *  hasn't produced an entry yet — the button only exists once one has. */
export function dismissSuggestion(key: string): void {
  const entry = cache.get(key)
  if (!entry) return
  setEntry(key, { ...entry, dismissed: true })
}

/** Test-only reset — the module-level maps otherwise leak state across test
 *  cases (and across items/messages within a single session, by design). */
export function resetSuggestionStoreForTests(): void {
  for (const { controller } of inflight.values()) controller.abort()
  inflight.clear()
  cache.clear()
  listeners.clear()
}
