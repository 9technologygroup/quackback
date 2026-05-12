/**
 * Admin "Test sign-in" button. Clicking it opens a modal that holds
 * the whole test lifecycle: a waiting state while the admin completes
 * the IdP round-trip in a popup, then the diagnostic result rendered
 * in-place when the callback route postMessages back. The modal is
 * the single visible surface — no inline result panel, no inline
 * error alert under the button.
 *
 * Fallbacks:
 *  - postMessage origin + source checks are the auth on result delivery.
 *  - 5-minute polling cap against `getSsoTestResultFn` covers the case
 *    where the popup lands on an off-origin error page and so can't post.
 *  - usePopupTracker flips the modal back to a "popup closed" error if
 *    the admin abandons the popup without finishing.
 *
 * Closing the modal mid-test aborts the polling, untracks the popup,
 * and resets state. Late postMessage / poll results after close are
 * ignored.
 */

import { useEffect, useRef, useState } from 'react'
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
import type { HandshakeResult } from '@/lib/server/auth/sso-test-handshake'
import { SSO_TEST_POSTMESSAGE_SOURCE } from '@/lib/shared/sso-test-keys'
import { openAuthPopup, usePopupTracker } from '@/lib/client/hooks/use-auth-broadcast'

const POLL_INTERVAL_MS = 2000
// 150 polls * 2s = 5 minutes. The Redis test-session TTL is 10
// minutes; bail well before that so we don't poll an expired session
// forever after the admin closes the popup without completing the
// IdP round-trip.
const MAX_POLLS = 150

/** Inline mirror of {@link HandshakeResult} minus the failure-branch
 *  `raw?: unknown` debug field. The callback route strips `raw` before
 *  writing the diagnostic to Redis (TanStack's serializable-input
 *  check rejects unknown shapes), so the wire payload is structurally
 *  this narrower type. */
type WireResult =
  | Extract<HandshakeResult, { ok: true }>
  | Omit<Extract<HandshakeResult, { ok: false }>, 'raw'>

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

export function TestSignInButton({ disabled }: { disabled?: boolean }) {
  const startTest = useServerFn(startSsoTestFn)
  const pollResult = useServerFn(getSsoTestResultFn)
  const [modalOpen, setModalOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<WireResult | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const clearPoll = () => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const { trackPopup, clearPopup } = usePopupTracker({
    onPopupClosed: () => {
      // Only react if the admin hasn't seen a result yet; a stale
      // close-callback after a successful test would otherwise stomp
      // the success UI.
      setTesting((stillTesting) => {
        if (!stillTesting) return stillTesting
        clearPoll()
        setError('You closed the popup before sign-in finished. Try again.')
        return false
      })
    },
  })

  // Listen for the callback route's postMessage. Origin + source checks
  // keep stray messages (extensions, other tabs, the IdP itself) from
  // ending the test early with garbage data.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return
      const data = e.data as { source?: string; result?: WireResult } | null
      if (!data || typeof data !== 'object') return
      if (data.source !== SSO_TEST_POSTMESSAGE_SOURCE) return
      if (!data.result) return
      setResult(data.result)
      setTesting(false)
      clearPoll()
      clearPopup()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [clearPopup])

  // Belt-and-braces cleanup if the component unmounts mid-test.
  useEffect(() => {
    return () => clearPoll()
  }, [])

  function handleClose() {
    clearPoll()
    clearPopup()
    setModalOpen(false)
    setTesting(false)
    // Keep `result` / `error` populated through the close animation;
    // the next `handleStart` clears them.
  }

  async function handleStart() {
    setError(null)
    setResult(null)
    setTesting(true)
    setModalOpen(true)
    let r: Awaited<ReturnType<typeof startTest>>
    try {
      r = await startTest({ data: {} })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the test.")
      setTesting(false)
      return
    }
    if ('error' in r) {
      setError(friendlyStartError(r.error))
      setTesting(false)
      return
    }
    const popup = openAuthPopup(r.authorizeUrl)
    if (!popup) {
      setError('Your browser blocked the popup. Allow popups and try again.')
      setTesting(false)
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
        setTesting(false)
        setError("Sign-in didn't finish in time. Try again, or check your IdP's redirect URI.")
        return
      }
      try {
        const diag = await pollResult({ data: { testId: r.testId } })
        if (diag && diag.result) {
          setResult(diag.result)
          setTesting(false)
          clearPoll()
          clearPopup()
        }
      } catch {
        // Swallow transient errors — the popup may still produce a
        // postMessage. We don't want to kill the test on one bad poll.
      }
    }, POLL_INTERVAL_MS)
  }

  return (
    <>
      <Button onClick={handleStart} disabled={disabled || testing} variant="outline">
        Test sign-in
      </Button>
      <Dialog
        open={modalOpen}
        onOpenChange={(open) => {
          if (!open) handleClose()
        }}
      >
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-lg">
          <DialogHeader className="shrink-0 px-6 pt-6 pb-2">
            <DialogTitle>Test sign-in</DialogTitle>
            <DialogDescription>
              {testing
                ? "Sign in to your IdP in the popup. We'll show what happened here when you're done."
                : result
                  ? result.ok
                    ? 'Looks good — everything went through.'
                    : "Something didn't connect. The steps below show where."
                  : "Sign in to your IdP in a popup. We'll walk you through what happened."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto px-6 pb-2">
            {error ? (
              <Alert variant="destructive">
                <ExclamationTriangleIcon className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : result ? (
              <TestResultPanel result={result} />
            ) : testing ? (
              <WaitingState />
            ) : null}
          </div>
          <DialogFooter className="shrink-0 px-6 pt-2 pb-6">
            {testing ? (
              <Button variant="outline" size="sm" onClick={handleClose}>
                Cancel
              </Button>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={handleClose}>
                  Close
                </Button>
                {(result || error) && (
                  <Button size="sm" onClick={handleStart}>
                    Try again
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function WaitingState() {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <ArrowPathIcon className="h-6 w-6 animate-spin text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">Waiting for your sign-in</p>
        <p className="text-xs text-muted-foreground">
          A popup just opened. Sign in there and the result will appear here.
        </p>
      </div>
    </div>
  )
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

function TestResultPanel({ result }: { result: WireResult }) {
  if (result.ok) {
    return (
      <div className="rounded-md border border-green-500/30 bg-green-500/5 p-3 space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium text-green-700">
          <CheckCircleIcon className="h-4 w-4" />
          Sign-in works
        </div>
        <StepList steps={result.steps} />
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Show what your IdP returned
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
