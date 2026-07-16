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
 * Streaming runs through a per-run `ChatClient` (TanStack AI's AG-UI protocol,
 * via `runAguiTurn`) rather than a component hook: a component-scoped client
 * would abort on unmount, the opposite of what a cross-remount cache needs — a
 * generation in flight when a teammate switches ITEMS should keep running, so
 * it's ready the moment they switch back. The one run worth killing is a
 * superseded one: when the SAME item gets a newer customer message, the old key
 * can never render again, so its client is stopped (see the in-flight registry
 * below) instead of burning tokens to completion.
 *
 * FINAL-ONLY: the store reads only the terminal RUN_FINISHED.result (the
 * `SuggestFinalPayload`) and ignores every partial chunk. A suggestion's honest
 * miss is only knowable at the end of the run, so a half-drafted guess must
 * never render even though the server may stream model chunks.
 */
import { runAguiTurn, type AguiRunHandle } from '@/lib/client/utils/agui-run'
import { GENERIC_ERROR } from '@/lib/client/utils/http-error'
import type { AssistantItemRef } from '@/lib/client/copilot-events'
import {
  type CopilotCitation,
  type SuggestFinalPayload,
} from '@/lib/shared/assistant/copilot-contract'

/** The AG-UI turn message. A suggestion carries no question — the
 *  `suggested_reply` intent owns the turn's drafting instruction server-side —
 *  so this placeholder is ignored (the route reads only forwardedProps). */
const SUGGEST_MESSAGE = 'Draft a suggested reply.'

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
/** One in-flight run: the message id it was started for, a `superseded` flag
 *  its own chunk handlers check (a superseded run's late frames must never flip
 *  the entry the supersede site already settled), and the ChatClient `stop`. */
interface InflightRun {
  messageId: string
  state: { superseded: boolean }
  stop: () => void
}
/** In-flight runs, keyed by ITEM id (not suggestion key): at most one
 *  generation per item is ever worth having. When `ensureSuggestion` starts a
 *  run for a NEWER customer message on the same item, the older run's key is
 *  permanently stale — nothing will ever render it — so its client is stopped
 *  rather than left burning tokens to completion (the server honors the abort).
 *  Runs for OTHER items stay untouched: those keys stay renderable, and
 *  finishing in the background is the whole point of the cross-remount cache. */
const inflight = new Map<string, InflightRun>()

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

function runSuggestion(
  key: string,
  item: SuggestItemRef,
  lastCustomerMessageId: string,
  state: { superseded: boolean }
): AguiRunHandle {
  let finished = false
  // Every handler below early-returns once this run is superseded: a supersede
  // means a newer run replaced this one (or a test reset tore the store down),
  // and THAT site already owns the entry's terminal state — a frame still
  // buffered in the old stream must not flip the superseded entry back to life.
  const run = runAguiTurn({
    url: '/api/admin/assistant/suggest',
    message: SUGGEST_MESSAGE,
    forwardedProps: { ...item, lastCustomerMessageId },
    onChunk: (chunk) => {
      if (state.superseded || finished) return
      const c = chunk as { type: string; result?: unknown; code?: unknown; message?: unknown }
      // FINAL-ONLY: partial chunks (text deltas, tool calls) are ignored; only
      // the terminal RUN_FINISHED.result transitions state. A bare
      // RUN_FINISHED without a result (the engine's own) is not our terminal.
      if (c.type === 'RUN_FINISHED') {
        if (c.result === undefined) return
        finished = true
        const final = c.result as SuggestFinalPayload
        const finalText = final.text || ''
        if (final.skip || !finalText.trim()) {
          // Honest miss — or a non-skip final that arrived with no usable text
          // (belt to the server's own guard): render nothing rather than a
          // bare card, and never counted as "shown".
          setEntry(key, { status: 'skip', text: '', citations: [], internalSourced: false })
        } else {
          // 'suggestion_shown' is NOT logged here: a final frame landing is not
          // a teammate seeing it (a background completion for an item nobody
          // has open would deflate the acceptance rate). The CARD logs shown on
          // first render of this entry, exactly-once via `markSuggestionShown`.
          setEntry(key, {
            status: 'done',
            text: finalText,
            citations: final.citations,
            internalSourced: final.internalSourced,
          })
        }
      } else if (c.type === 'RUN_ERROR') {
        finished = true
        // A 409 rides the wire as a `http_409` RUN_ERROR (see aguiFetchClient):
        // the suggest route's staleness/closed signal. Not a failure worth a
        // doomed Retry card (retrying re-sends the same stale id) — render
        // nothing; the newer message is a new cache key, which regenerates.
        if (c.code === 'http_409') {
          setEntry(key, { status: 'skip', text: '', citations: [], internalSourced: false })
        } else {
          setEntry(
            key,
            errorEntry(typeof c.message === 'string' && c.message ? c.message : GENERIC_ERROR)
          )
        }
      }
    },
    onError: (error) => {
      // A transport failure that never produced a RUN_ERROR chunk (rare — HTTP
      // errors ride the synthetic RUN_ERROR frame).
      if (state.superseded || finished) return
      finished = true
      setEntry(key, errorEntry(error.message || GENERIC_ERROR))
    },
  })

  void run.done.then(() => {
    // Stream ended without a terminal final/error frame — a quiet failure, same
    // retry affordance as an explicit error event. A superseded run owns
    // nothing (the supersede site already settled its entry, or a reset wants
    // the maps empty), and an abort resolves `done` the same way.
    if (!finished && !state.superseded) setEntry(key, errorEntry(GENERIC_ERROR))
  })

  return run
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
    // Mark superseded BEFORE stopping so any late/buffered frame this run still
    // delivers is dropped by its own handlers rather than reviving the entry.
    prior.state.superseded = true
    prior.stop()
    inflight.delete(itemId)
  }

  setEntry(key, LOADING_ENTRY)
  evictOverCap()
  const state = { superseded: false }
  const run = runSuggestion(key, item, lastCustomerMessageId, state)
  const entry: InflightRun = { messageId: lastCustomerMessageId, state, stop: run.stop }
  inflight.set(itemId, entry)
  void run.done.finally(() => {
    if (inflight.get(itemId) === entry) inflight.delete(itemId)
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
  for (const run of inflight.values()) {
    run.state.superseded = true
    run.stop()
  }
  inflight.clear()
  cache.clear()
  listeners.clear()
}
