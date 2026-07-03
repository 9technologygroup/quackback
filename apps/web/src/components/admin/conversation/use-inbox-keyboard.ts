/**
 * The inbox's keyboard-first layer (support platform §4.6). A thin global
 * keydown hook over a pure `resolveShortcut` resolver so the key mapping and the
 * input-focus suppression are unit-testable without a DOM.
 *
 * Bindings:
 * - Cmd/Ctrl-K   → open the command bar (allowed from anywhere, even inputs)
 * - ?            → open the shortcut help (suppressed while typing)
 * - single keys  → the common actions (r/a/t/s/p/e/u, j/k, x), all
 *                  suppressed while typing or when a modifier is held
 *
 * The single-key chars come from `INBOX_ACTIONS` (each descriptor's `shortcut`),
 * so this file adds no new source of truth for them.
 */
import { useEffect, useRef } from 'react'
import { INBOX_ACTIONS, type InboxActionId } from '@/lib/shared/conversation/inbox-actions'

/**
 * Non-action global shortcuts (display strings), single-sourced here for the
 * help panel. Action keys live on the descriptors; these two are the only keys
 * this hook owns that aren't actions.
 */
export const INBOX_GLOBAL_SHORTCUTS: ReadonlyArray<{ keys: string; label: string }> = [
  { keys: '⌘K', label: 'Open command bar' },
  { keys: '?', label: 'Show keyboard shortcuts' },
]

/** Single-key char → action id, derived from the registry (chars are unique). */
const KEY_TO_ACTION: Readonly<Record<string, InboxActionId>> = Object.fromEntries(
  INBOX_ACTIONS.filter((a) => a.shortcut).map((a) => [a.shortcut!.toLowerCase(), a.id])
)

/** The minimal shape `resolveShortcut` reads — a KeyboardEvent satisfies it. */
export interface ResolvableKeyEvent {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  target?: EventTarget | null
}

export type InboxShortcutResult =
  | { type: 'command-bar' }
  | { type: 'help' }
  | { type: 'action'; id: InboxActionId }
  | null

/**
 * True when the event originated in a text-entry surface, so typing a reply
 * never fires an action. Duck-typed (not `instanceof`) so it works against real
 * events and plain test objects alike.
 */
export function isEditableTarget(target: EventTarget | null | undefined): boolean {
  if (!target) return false
  const el = target as { tagName?: string; isContentEditable?: boolean }
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return el.isContentEditable === true
}

/**
 * Pure key → intent resolver. Returns `null` when nothing should fire.
 *
 * Cmd/Ctrl-K is honoured from anywhere. Everything else is suppressed while
 * typing. Single-key actions additionally require no modifier held (so Ctrl-R
 * still reloads and shift-selection never triggers an action).
 */
export function resolveShortcut(e: ResolvableKeyEvent): InboxShortcutResult {
  const key = e.key
  const mod = Boolean(e.metaKey || e.ctrlKey)

  // Cmd/Ctrl-K — allowed even from an input.
  if (mod && key.toLowerCase() === 'k') return { type: 'command-bar' }

  const typing = isEditableTarget(e.target)

  // ? — allowed from anywhere except while typing. Needs no Cmd/Ctrl/Alt.
  if (!typing && !mod && !e.altKey && key === '?') return { type: 'help' }

  // Single-key actions — never while typing or with any modifier.
  if (typing || mod || e.altKey || e.shiftKey) return null
  const id = KEY_TO_ACTION[key.toLowerCase()]
  return id ? { type: 'action', id } : null
}

export interface UseInboxKeyboardOptions {
  /** Bind while true; unbind on false/unmount. */
  enabled: boolean
  onAction: (id: InboxActionId) => void
  onOpenCommandBar: () => void
  onOpenHelp: () => void
}

/** Binds a global keydown listener that dispatches via `resolveShortcut`. */
export function useInboxKeyboard({
  enabled,
  onAction,
  onOpenCommandBar,
  onOpenHelp,
}: UseInboxKeyboardOptions): void {
  // Latest callbacks in a ref so the listener identity stays stable across renders.
  const handlers = useRef({ onAction, onOpenCommandBar, onOpenHelp })
  handlers.current = { onAction, onOpenCommandBar, onOpenHelp }

  useEffect(() => {
    if (!enabled) return
    function onKeyDown(event: KeyboardEvent) {
      const result = resolveShortcut(event)
      if (!result) return
      event.preventDefault()
      if (result.type === 'command-bar') handlers.current.onOpenCommandBar()
      else if (result.type === 'help') handlers.current.onOpenHelp()
      else handlers.current.onAction(result.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
