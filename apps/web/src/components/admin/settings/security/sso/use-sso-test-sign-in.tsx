/**
 * Shared SSO test sign-in modal — one instance per `<SsoPage>`, driven
 * through React context so three triggers can open the same modal:
 *
 *   1. the standalone "Test sign-in" button,
 *   2. the "Enable" toggle (gate: enabling SSO needs a valid test),
 *   3. the per-domain "Require SSO" toggle (same gate for enforcement).
 *
 * The gate triggers pass a `reason` (shown in the prompt) and an
 * `onSuccess` callback. `onSuccess` fires on ANY successful test — the
 * server stamps `ssoOidc.lastSuccessfulTestAt` on success, so the
 * originally-attempted action (enable / enforce) will pass its
 * server-side gate. The IdP-returned identity is shown in the result
 * panel for context but does not gate the auto-apply.
 *
 * The popup / polling / postMessage lifecycle is lifted verbatim from
 * the old self-contained `<TestSignInButton>` — only the owner moved.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useServerFn } from '@tanstack/react-start'
import { ArrowPathIcon, CheckCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/24/solid'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { startSsoTestFn, getSsoTestResultFn } from '@/lib/server/functions/sso-test'
import { SSO_TEST_POSTMESSAGE_SOURCE } from '@/lib/shared/sso-test-keys'
import { openAuthPopup, usePopupTracker } from '@/lib/client/hooks/use-auth-broadcast'
import { ssoTestReducer, initialSsoTestState, type WireResult } from './sso-test-state'

const POLL_INTERVAL_MS = 2000
// 150 polls * 2s = 5 minutes. Redis test-session TTL is 10 minutes;
// bail well before that so we don't poll an expired session forever.
const MAX_POLLS = 150

/** Callback fired when a test sign-in succeeds — used by the Enable /
 *  Require-SSO gates to auto-apply the action that triggered the
 *  prompt. May be async; the modal shows "Applying…" while it runs. */
type OnSuccess = () => void | Promise<void>

interface OpenOptions {
  /** Gate context shown in the prompt, e.g. "Test sign-in required
   *  before enabling SSO." Omit for the standalone Test button. */
  reason?: string
  /** Runs after a successful test sign-in. */
  onSuccess?: OnSuccess
}

interface SsoTestSignInContextValue {
  /** Open the modal in its prompt state. */
  open: (opts?: OpenOptions) => void
}

const SsoTestSignInContext = createContext<SsoTestSignInContextValue | null>(null)

/** Access the shared modal. Must be rendered under `<SsoTestSignInProvider>`. */
export function useSsoTestSignIn(): SsoTestSignInContextValue {
  const ctx = useContext(SsoTestSignInContext)
  if (!ctx) {
    throw new Error('useSsoTestSignIn must be used within <SsoTestSignInProvider>')
  }
  return ctx
}

export function SsoTestSignInProvider({ children }: { children: ReactNode }) {
  const startTest = useServerFn(startSsoTestFn)
  const pollResult = useServerFn(getSsoTestResultFn)
  const [state, dispatch] = useReducer(ssoTestReducer, initialSsoTestState)
  // `true` while a successful test's onSuccess callback runs.
  const [applying, setApplying] = useState(false)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onSuccessRef = useRef<OnSuccess | null>(null)
  // Mirror "is a test actively in flight" in a ref so the popup / poll /
  // postMessage handlers read the latest value without re-attaching.
  // Gating on `=== 'testing'` (not `!== 'closed'`) is load-bearing: the
  // IdP callback popup auto-closes ~1.5s AFTER a successful sign-in, so
  // by the time `onPopupClosed` fires the phase is already 'result'.
  // Treating that as an abandoned popup would stomp the success state
  // and race the auto-apply.
  const testingRef = useRef(false)
  useEffect(() => {
    testingRef.current = state.phase === 'testing'
  }, [state.phase])

  const clearPoll = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const { trackPopup, clearPopup } = usePopupTracker({
    onPopupClosed: () => {
      // Only react while the test is still in flight — a close callback
      // after a result (incl. the popup's own auto-close on success)
      // must not stomp the result UI.
      if (!testingRef.current) return
      clearPoll()
      dispatch({
        type: 'failed',
        error: 'You closed the popup before sign-in finished. Try again.',
      })
    },
  })

  // After a successful test, run the gate's onSuccess (e.g. "now
  // actually enable SSO"), showing "Applying…" while it runs, then
  // close. No-op when there's no pending action (the standalone Test
  // button opens the modal without an onSuccess).
  const runAutoApply = useCallback(async () => {
    const cb = onSuccessRef.current
    if (!cb) return
    setApplying(true)
    try {
      await cb()
      dispatch({ type: 'close' })
    } catch (err) {
      dispatch({
        type: 'failed',
        error: err instanceof Error ? err.message : 'Could not apply the change.',
      })
    } finally {
      setApplying(false)
      onSuccessRef.current = null
    }
  }, [])

  // postMessage listener — origin + source checks keep stray messages
  // (extensions, other tabs, the IdP itself) from ending the test early.
  // Only act while testing: a late message after the poll already
  // resolved (or after close) is dropped.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (!testingRef.current) return
      if (e.origin !== window.location.origin) return
      const data = e.data as {
        source?: string
        result?: WireResult
        identityMatched?: boolean
      } | null
      if (!data || typeof data !== 'object') return
      if (data.source !== SSO_TEST_POSTMESSAGE_SOURCE) return
      if (!data.result) return
      clearPoll()
      clearPopup()
      dispatch({
        type: 'resolved',
        result: data.result,
        identityMatched: data.identityMatched,
      })
      if (data.result.ok) void runAutoApply()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [clearPoll, clearPopup, runAutoApply])

  // Belt-and-braces cleanup if the provider unmounts mid-test.
  useEffect(() => () => clearPoll(), [clearPoll])

  const handleClose = useCallback(() => {
    clearPoll()
    clearPopup()
    onSuccessRef.current = null
    dispatch({ type: 'close' })
  }, [clearPoll, clearPopup])

  const open = useCallback((opts?: OpenOptions) => {
    onSuccessRef.current = opts?.onSuccess ?? null
    dispatch({ type: 'open', reason: opts?.reason })
  }, [])

  const handleStart = useCallback(async () => {
    dispatch({ type: 'start' })
    let r: Awaited<ReturnType<typeof startTest>>
    try {
      r = await startTest({ data: {} })
    } catch (err) {
      dispatch({
        type: 'failed',
        error: err instanceof Error ? err.message : "Couldn't start the test.",
      })
      return
    }
    if ('error' in r) {
      dispatch({ type: 'failed', error: friendlyStartError(r.error) })
      return
    }
    const popup = openAuthPopup(r.authorizeUrl)
    if (!popup) {
      dispatch({
        type: 'failed',
        error: 'Your browser blocked the popup. Allow popups and try again.',
      })
      return
    }
    trackPopup(popup)
    clearPoll()
    let pollCount = 0
    pollRef.current = setInterval(async () => {
      pollCount += 1
      if (pollCount > MAX_POLLS) {
        clearPoll()
        clearPopup()
        dispatch({
          type: 'failed',
          error: "Sign-in didn't finish in time. Try again, or check your IdP's redirect URI.",
        })
        return
      }
      try {
        const diag = await pollResult({ data: { testId: r.testId } })
        if (diag && diag.result) {
          clearPoll()
          clearPopup()
          // The postMessage path may have already resolved this test —
          // if we're no longer testing, drop the poll result.
          if (!testingRef.current) return
          dispatch({
            type: 'resolved',
            result: diag.result,
            identityMatched: diag.identityMatched,
          })
          if (diag.result.ok) void runAutoApply()
        }
      } catch {
        // Transient poll error — the popup may still postMessage.
      }
    }, POLL_INTERVAL_MS)
  }, [startTest, pollResult, trackPopup, clearPoll, clearPopup, runAutoApply])

  return (
    <SsoTestSignInContext.Provider value={{ open }}>
      {children}
      <SsoTestSignInModal
        state={state}
        applying={applying}
        onStart={handleStart}
        onClose={handleClose}
      />
    </SsoTestSignInContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Modal — pure presentational, driven entirely by reducer state.
// ---------------------------------------------------------------------------

function SsoTestSignInModal({
  state,
  applying,
  onStart,
  onClose,
}: {
  state: ReturnType<typeof ssoTestReducer>
  applying: boolean
  onStart: () => void
  onClose: () => void
}) {
  const { phase, reason, result, error, identityMatched } = state
  return (
    <Dialog
      open={phase !== 'closed'}
      onOpenChange={(o) => {
        // Block close while a test is in flight or auto-apply is running
        // — a half-applied gate action would be confusing.
        if (!o && phase === 'testing') return
        if (!o && applying) return
        if (!o) onClose()
      }}
    >
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-2">
          <DialogTitle>Test sign-in</DialogTitle>
          <DialogDescription>{describeModalState(state, applying)}</DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-6 pb-2">
          {phase === 'prompt' ? (
            <PromptState reason={reason} />
          ) : error ? (
            <Alert variant="destructive">
              <ExclamationTriangleIcon className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : result ? (
            <TestResultPanel result={result} identityMatched={identityMatched} />
          ) : phase === 'testing' ? (
            <WaitingState />
          ) : null}
        </div>
        <DialogFooter className="shrink-0 px-6 pt-2 pb-6">
          {phase === 'prompt' ? (
            <>
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={onStart}>
                Start test sign-in
              </Button>
            </>
          ) : phase === 'testing' ? (
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={onClose} disabled={applying}>
                Close
              </Button>
              {(result || error) && !applying && (
                <Button size="sm" onClick={onStart}>
                  Try again
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PromptState({ reason }: { reason: string | null }) {
  return (
    <div className="space-y-3 py-2">
      {reason ? (
        <Alert>
          <ExclamationTriangleIcon className="h-4 w-4" />
          <AlertDescription>{reason}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-sm text-muted-foreground">
        We&apos;ll open your IdP in a popup. Nothing changes until the test passes.
      </p>
    </div>
  )
}

function WaitingState() {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <ArrowPathIcon className="h-6 w-6 animate-spin text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">Waiting for sign-in</p>
        <p className="text-xs text-muted-foreground">Finish signing in in the popup.</p>
      </div>
    </div>
  )
}

/** Modal description copy for the current phase. */
function describeModalState(state: ReturnType<typeof ssoTestReducer>, applying: boolean): string {
  if (applying) return 'Sign-in works. Applying…'
  if (state.phase === 'prompt') {
    return state.reason
      ? 'Verify your SSO connection first.'
      : 'Check that your SSO connection works.'
  }
  if (state.phase === 'testing') return 'Finish signing in in the popup.'
  if (state.result) {
    return state.result.ok ? 'Your SSO connection works.' : "Sign-in didn't complete."
  }
  if (state.error) return 'Sign-in failed.'
  return 'Check that your SSO connection works.'
}

function friendlyStartError(error: string): string {
  switch (error) {
    case 'sso-not-configured':
      return 'Add your discovery URL and client ID first.'
    case 'no-secret':
      return 'Add your client secret first.'
    case 'discovery-unreachable':
      return "We couldn't reach your IdP. Check that your discovery URL is correct."
    default:
      return error
  }
}

const STAGE_LABELS: Record<string, string> = {
  'state-validation': 'State validation',
  'idp-authorize': 'IdP authorize',
  'discovery-fetch': 'Discovery fetch',
  'token-exchange': 'Token exchange',
  'id-token-decode': 'ID token decode',
  'signature-verify': 'Signature verify',
  'claim-check': 'Claim check',
  userinfo: 'Userinfo',
}

function StepList({ steps }: { steps: WireResult['steps'] }) {
  if (steps.length === 0) return null
  return (
    <ul className="space-y-1 text-xs">
      {steps.map((s, i) => (
        <li key={i} className="flex items-start gap-2">
          {s.ok ? (
            <CheckCircleIcon className="h-3.5 w-3.5 text-green-600 mt-0.5 shrink-0" />
          ) : (
            <ExclamationTriangleIcon className="h-3.5 w-3.5 text-destructive mt-0.5 shrink-0" />
          )}
          <span>
            <span className="font-medium">{s.label}</span>
            {s.detail && <span className="text-muted-foreground"> — {s.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

function TestResultPanel({
  result,
  identityMatched,
}: {
  result: WireResult
  identityMatched: boolean | undefined
}) {
  if (result.ok) {
    return (
      <div className="rounded-md border border-green-500/30 bg-green-500/5 p-3 space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium text-green-700">
          <CheckCircleIcon className="h-4 w-4" />
          Sign-in works
        </div>
        <StepList steps={result.steps} />
        {/* Identity is informational only — it doesn't gate anything.
         *  Flag a mismatch so the admin notices if they tested as the
         *  wrong account, but the SSO connection itself is verified. */}
        {identityMatched === false && result.claims.email ? (
          <div className="rounded border border-muted bg-muted/30 p-2 text-xs text-muted-foreground">
            Tested as {result.claims.email} — a different account than yours. The connection still
            works.
          </div>
        ) : null}
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Show IdP response
          </summary>
          <pre className="mt-2 overflow-auto rounded bg-muted/30 p-2 font-mono text-[11px]">
            {JSON.stringify({ claims: result.claims, tokenInfo: result.tokenInfo }, null, 2)}
          </pre>
        </details>
      </div>
    )
  }
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-destructive">
        <ExclamationTriangleIcon className="h-4 w-4" />
        Stopped at: {STAGE_LABELS[result.stage] ?? result.stage}
        {result.errorCode && (
          <code className="ml-1 text-[11px] text-muted-foreground">({result.errorCode})</code>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{result.hint}</p>
      <StepList steps={result.steps} />
    </div>
  )
}
