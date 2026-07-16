/**
 * Quinn's proactive suggested-reply card (QUINN-PROACTIVE-SUGGESTIONS-SPEC.md):
 * renders above the reply composer (agent-conversation-thread.tsx) whenever
 * the latest message in the open conversation/ticket is from the customer
 * with no teammate reply after it yet. Pull-on-view, not push-per-message —
 * mounting this component (which only happens for the item a teammate has
 * open) IS the trigger; there is no separate "is anyone looking" check.
 *
 * "On view" is deliberately stricter than "on mount" — every generation is a
 * paid LLM turn, so three gates sit between mounting and spending one:
 *
 *  - a short dwell (SUGGESTION_DWELL_MS) before generation starts, cleared on
 *    unmount: arrow-keying through a queue of customer-waiting conversations
 *    passes through many mounts that never become a real look;
 *  - a hidden document defers the dwell's firing until the tab becomes
 *    visible (if this card is still mounted then) — a background tab isn't a
 *    view;
 *  - `shouldDeferSuggestion` (the host's reply-draft-has-text check), consulted
 *    at fire time: a teammate already mid-reply doesn't need a draft. Note
 *    drafts deliberately don't defer — a customer reply is still owed after
 *    an internal note. This is a one-shot skip, not a watcher — clearing the
 *    draft doesn't retrigger generation; the next keystroke of a customer
 *    message (new key) or the next mount does.
 *
 * Silence-rule note: the silence rule governs Quinn speaking TO the customer.
 * A suggestion never reaches the customer by itself — it is agent-facing
 * assist, same as the Copilot panel, so it is never gated by that rule.
 *
 * Streams POST /api/admin/assistant/suggest (AG-UI; final-only rendering)
 * through the module-level cache in suggested-reply-store.ts, which is what
 * makes "generate once per (item, lastCustomerMessageId)" and "tab
 * switches/re-renders never re-fetch" hold even though this component fully
 * remounts whenever the teammate opens a different item (the inbox route
 * keys the whole thread subtree by item id).
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ArrowPathIcon, SparklesIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { AssistantAnswer } from '@/components/shared/conversation/assistant-turn'
import { TypingDots } from '@/components/shared/typing-dots'
import { InternalSourcesConfirm } from './internal-sources-confirm'
import { useSuggestedReplyGate } from '@/lib/client/hooks/use-suggested-reply-gate'
import { itemRefBody, recordCopilotEvent } from '@/lib/client/copilot-events'
import {
  dismissSuggestion,
  ensureSuggestion,
  getSuggestionEntry,
  markSuggestionShown,
  retrySuggestion,
  subscribeSuggestion,
  suggestionKey,
} from '@/lib/client/suggested-reply-store'
import type { InboxItemRef } from '@/lib/shared/inbox/items'

/** How long the card must stay mounted before generation starts. Long enough
 *  that keyboard-paging through the inbox list never spends a turn per
 *  conversation skimmed past; short enough to be imperceptible on a real
 *  open. */
export const SUGGESTION_DWELL_MS = 800

export function SuggestedReplyCard({
  item,
  lastCustomerMessageId,
  onInsert,
  onAskCopilot,
  shouldDeferSuggestion,
  dwellMs = SUGGESTION_DWELL_MS,
}: {
  /** The open conversation or ticket. */
  item: InboxItemRef
  /** The customer message this suggestion drafts a reply to — also the cache
   *  key's other half; a new id (a new customer message) generates fresh and
   *  revives a previously-dismissed card. */
  lastCustomerMessageId: string
  /** Insert the suggestion's text into the reply composer, through the SAME
   *  answer insert seam the Copilot panel uses (appendAnswerToDraft, via
   *  agent-conversation-thread.tsx's `insertFromCopilot(text, 'reply')`) —
   *  marks/fences/lists render correctly, and it flips out of note mode if
   *  the teammate happened to be writing one. */
  onInsert: (text: string) => void
  /** Open the Copilot tab (the route's openCopilotToken bump). Absent when
   *  there is no Copilot panel to open right now (flag/permission gate, or a
   *  viewport too narrow to render the detail panel) — the Ask Copilot link
   *  is hidden rather than rendered dead. */
  onAskCopilot?: () => void
  /** Stable pull-based getter consulted at dwell-fire time: true skips this
   *  key's generation entirely (see the module doc's composer gate). The
   *  thread wires it to its composer-text ref, so a teammate already drafting
   *  a reply never pays for a suggestion they won't use. */
  shouldDeferSuggestion?: () => boolean
  /** Test seam only — the dwell before generation may start. */
  dwellMs?: number
}) {
  const gateOpen = useSuggestedReplyGate()
  const item_ = itemRefBody(item)
  const key = suggestionKey(item.id, lastCustomerMessageId)

  useEffect(() => {
    if (!gateOpen) return
    // ensureSuggestion is what SPENDS (a no-op for a cached/in-flight key);
    // rendering an already-cached entry needs no call here — the
    // useSyncExternalStore read below sees it regardless. So the dwell +
    // visibility + composer gates below only ever delay/skip fresh spend,
    // never the display of something already paid for.
    const fire = () => {
      if (shouldDeferSuggestion?.()) return
      ensureSuggestion(key, itemRefBody(item), lastCustomerMessageId)
    }
    let onVisible: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null
      if (document.visibilityState === 'hidden') {
        // Dwell elapsed in a hidden tab: hold fire until it becomes visible
        // (still mounted = still the open item), then apply the same
        // composer gate at that moment.
        onVisible = () => {
          if (document.visibilityState !== 'visible') return
          document.removeEventListener('visibilitychange', onVisible!)
          onVisible = null
          fire()
        }
        document.addEventListener('visibilitychange', onVisible)
        return
      }
      fire()
    }, dwellMs)
    return () => {
      if (timer !== null) clearTimeout(timer)
      if (onVisible) document.removeEventListener('visibilitychange', onVisible)
    }
    // `key` already encodes item.id + lastCustomerMessageId, so it alone (plus
    // the gate/dwell/defer wiring) is the whole dep list — the item-ref body
    // is re-derived inside `fire` (a fresh-but-equal-value literal every call)
    // rather than listed, and item.kind never changes for a given item id.
  }, [gateOpen, key, dwellMs, shouldDeferSuggestion])

  const entry = useSyncExternalStore(
    (listener) => subscribeSuggestion(key, listener),
    () => getSuggestionEntry(key),
    () => getSuggestionEntry(key)
  )

  // 'suggestion_shown' — the acceptance-rate denominator — fires when a
  // generated (done, non-skip, non-dismissed) card actually RENDERS, not when
  // the store's final frame lands: a background completion for an item nobody
  // has open must not deflate the acceptance rate. Exactly-once across
  // remounts/re-renders is the store's job (`markSuggestionShown` flips the
  // entry-level shownLogged flag and returns true only on the first flip).
  // Shown/dismissed carry neither destination nor rating (the suggest usage-event
  // contract doc) — only the item + kind, so the denominator can never be
  // conflated with an actual insert destination.
  const shownRenderable = gateOpen && entry?.status === 'done' && !entry.dismissed
  useEffect(() => {
    if (!shownRenderable) return
    if (markSuggestionShown(key)) {
      recordCopilotEvent({ item: itemRefBody(item), eventType: 'suggestion_shown' })
    }
    // As above: `key` covers item.id; the item-ref body is re-derived inside.
  }, [shownRenderable, key])

  const [pendingInsert, setPendingInsert] = useState(false)

  if (!gateOpen) return null
  // skip:true (honest miss) and an explicit dismiss both render NOTHING —
  // never an empty card.
  if (!entry || entry.dismissed || entry.status === 'skip') return null

  const doInsert = () => {
    onInsert(entry.text)
    recordCopilotEvent({
      item: item_,
      eventType: 'suggestion_inserted',
      destination: 'reply',
      answerType: 'draft_reply',
      internalSourced: entry.internalSourced,
    })
    setPendingInsert(false)
  }

  const handleInsertClick = () => {
    if (entry.internalSourced) setPendingInsert(true)
    else doInsert()
  }

  const handleDismiss = () => {
    dismissSuggestion(key)
    recordCopilotEvent({ item: item_, eventType: 'suggestion_dismissed' })
  }

  const handleRetry = () => retrySuggestion(key, item_, lastCustomerMessageId)

  return (
    <div className="mb-2 rounded-lg border border-border/60 bg-muted/30 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <SparklesIcon className="size-3.5 text-primary/70" />
        Suggested reply
      </div>

      {(entry.status === 'loading' || (entry.status === 'streaming' && !entry.text)) && (
        <div className="flex items-center gap-2 py-1 text-muted-foreground">
          <TypingDots />
        </div>
      )}

      {(entry.status === 'streaming' || entry.status === 'done') && entry.text && (
        <AssistantAnswer
          text={entry.text}
          citations={entry.citations}
          caret={entry.status === 'streaming'}
        />
      )}

      {entry.status === 'error' && (
        <div className="space-y-1.5">
          <p className="text-[13px] text-muted-foreground">
            {entry.errorMessage || 'Could not draft a suggestion.'}
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={handleRetry}>
            <ArrowPathIcon className="size-3.5" />
            Retry
          </Button>
        </div>
      )}

      {entry.status === 'done' && entry.text && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button type="button" size="sm" onClick={handleInsertClick}>
            Insert
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={handleDismiss}>
            Dismiss
          </Button>
          {onAskCopilot && (
            <button
              type="button"
              onClick={onAskCopilot}
              className="ms-auto text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Ask Copilot
            </button>
          )}
        </div>
      )}

      <InternalSourcesConfirm
        open={pendingInsert}
        noun="suggestion"
        confirmLabel="Insert anyway"
        onConfirm={doInsert}
        onCancel={() => setPendingInsert(false)}
      />
    </div>
  )
}
