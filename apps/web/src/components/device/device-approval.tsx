/**
 * The page where a person approves a headless client's sign-in (RFC 8628).
 *
 * The client (a CLI, an MCP client on a server) showed a short code. The person
 * types or follows it here, sees which client is asking and for what, and
 * approves with the same capability choices the browser consent offers: never
 * more than the client asked for.
 */
import { useEffect, useState } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { CheckCircle2, Globe, ShieldCheck, XCircle } from 'lucide-react'
import { DomainAccessPicker } from '@/components/domain-access-picker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SignInAgainDialog } from '@/components/auth/sign-in-again-dialog'
import { useSignInAgain } from '@/lib/client/hooks/use-sign-in-again'
import { isRecentSignInRequired } from '@/lib/shared/recent-sign-in'
import { domainAccessLevels, scopesFromDomainLevels } from '@/lib/shared/api-key-scopes'
import {
  deviceAllowedLevels,
  deviceRequestedCapabilities,
  deviceRequestedOfflineAccess,
} from '@/lib/shared/device-grant-scopes'
import {
  decideDeviceCodeFn,
  lookupDeviceCodeFn,
  type DeviceCodeLookup,
  type DeviceDecisionRefusal,
} from '@/lib/server/functions/device-auth'

type Ready = Extract<DeviceCodeLookup, { state: 'ready' }>

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-8">{children}</div>
    </div>
  )
}

function Notice({
  tone,
  title,
  body,
}: {
  tone: 'ok' | 'bad'
  title: React.ReactNode
  body: React.ReactNode
}) {
  const Icon = tone === 'ok' ? CheckCircle2 : XCircle
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <Icon
        className={`h-10 w-10 ${tone === 'ok' ? 'text-emerald-600' : 'text-muted-foreground'}`}
        aria-hidden
      />
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  )
}

/** The code field, for a person who arrived without one in the link. */
function EnterCode({ onSubmit }: { onSubmit: (code: string) => void }) {
  const intl = useIntl()
  const [code, setCode] = useState('')
  return (
    <Shell>
      <div className="flex flex-col items-center gap-1.5 text-center">
        <h1 className="text-xl font-semibold">
          <FormattedMessage
            id="oauthDevice.enter.title"
            defaultMessage="Enter the code from your device"
          />
        </h1>
        <p className="text-sm text-muted-foreground">
          <FormattedMessage
            id="oauthDevice.enter.hint"
            defaultMessage="It is shown where you started signing in."
          />
        </p>
      </div>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (code.trim()) onSubmit(code.trim())
        }}
      >
        <Input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          aria-label={intl.formatMessage({
            id: 'oauthDevice.enter.label',
            defaultMessage: 'Code',
          })}
          autoComplete="off"
          autoCapitalize="characters"
          autoFocus
          className="h-12 text-center font-mono text-lg tracking-[0.3em] uppercase"
        />
        <Button type="submit" size="lg" className="w-full" disabled={!code.trim()}>
          <FormattedMessage id="oauthDevice.enter.submit" defaultMessage="Continue" />
        </Button>
      </form>
    </Shell>
  )
}

function ProblemMessage({ reason }: { reason: DeviceDecisionRefusal | 'error' | 'settled' }) {
  switch (reason) {
    case 'invalid':
      return (
        <FormattedMessage
          id="oauthDevice.problem.invalid"
          defaultMessage="That code is not valid. Check it and try again."
        />
      )
    case 'expired':
      return (
        <FormattedMessage
          id="oauthDevice.problem.expired"
          defaultMessage="That code has expired. Start signing in again on your device."
        />
      )
    case 'unavailable':
      return (
        <FormattedMessage
          id="oauthDevice.problem.unavailable"
          defaultMessage="This code was opened by another account. Start signing in again on your device."
        />
      )
    case 'settled':
      return (
        <FormattedMessage
          id="oauthDevice.problem.settled"
          defaultMessage="This code has already been used."
        />
      )
    case 'rate_limited':
      return (
        <FormattedMessage
          id="oauthDevice.problem.rateLimited"
          defaultMessage="Too many attempts. Try again in a minute."
        />
      )
    case 'no_scopes':
      return (
        <FormattedMessage
          id="oauthDevice.problem.noScopes"
          defaultMessage="Choose at least one thing to allow."
        />
      )
    default:
      return (
        <FormattedMessage
          id="oauthDevice.problem.error"
          defaultMessage="Something went wrong. Please try again."
        />
      )
  }
}

function Approval({ request, onRetry }: { request: Ready; onRetry: () => void }) {
  const intl = useIntl()
  const clientName =
    request.clientName ??
    intl.formatMessage({ id: 'oauthDevice.unnamedClient', defaultMessage: 'An application' })
  const allowed = deviceAllowedLevels(request.requestedScope)
  const asksToStay = deviceRequestedOfflineAccess(request.requestedScope)
  const [levels, setLevels] = useState(() =>
    domainAccessLevels(deviceRequestedCapabilities(request.requestedScope))
  )
  const [stay, setStay] = useState(asksToStay)
  const [submitting, setSubmitting] = useState<'accept' | 'deny' | null>(null)
  const [problem, setProblem] = useState<DeviceDecisionRefusal | 'error' | null>(null)
  const [done, setDone] = useState<'approved' | 'denied' | null>(null)
  // Approving needs a recent sign-in. Once the person has signed in again they
  // press Approve again: their choices are not carried across a redirect, and
  // approving with different ones than they last saw is the wrong default.
  const signInAgain = useSignInAgain({ onSignedIn: () => setProblem(null) })

  const selected = scopesFromDomainLevels(levels)
  const needsChoice = deviceRequestedCapabilities(request.requestedScope).length > 0
  const clientDomain =
    request.clientUri && isSafeUrl(request.clientUri) ? new URL(request.clientUri).hostname : null

  async function decide(accept: boolean) {
    setSubmitting(accept ? 'accept' : 'deny')
    setProblem(null)
    try {
      const result = await decideDeviceCodeFn({
        data: {
          userCode: request.userCode,
          accept,
          selectedScopes: selected,
          offlineAccess: stay,
        },
      })
      if (isRecentSignInRequired(result)) signInAgain.request('device:accept')
      else if (result.ok) setDone(result.status)
      else setProblem(result.reason)
    } catch {
      setProblem('error')
    }
    setSubmitting(null)
  }

  if (done === 'approved') {
    return (
      <Shell>
        <Notice
          tone="ok"
          title={<FormattedMessage id="oauthDevice.done.approvedTitle" defaultMessage="Approved" />}
          body={
            <FormattedMessage
              id="oauthDevice.done.approvedBody"
              defaultMessage="You can close this page. {client} finishes signing in on its own."
              values={{ client: clientName }}
            />
          }
        />
      </Shell>
    )
  }
  if (done === 'denied') {
    return (
      <Shell>
        <Notice
          tone="bad"
          title={
            <FormattedMessage id="oauthDevice.done.deniedTitle" defaultMessage="Request denied" />
          }
          body={
            <FormattedMessage
              id="oauthDevice.done.deniedBody"
              defaultMessage="{client} was not given access."
              values={{ client: clientName }}
            />
          }
        />
      </Shell>
    )
  }

  return (
    <Shell>
      <SignInAgainDialog {...signInAgain.dialog} />
      <div className="flex flex-col items-center gap-1.5 text-center">
        <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-full border border-border/50 bg-muted/50">
          <Globe className="h-5 w-5 text-muted-foreground" aria-hidden />
        </div>
        <h1 className="text-xl font-semibold">{clientName}</h1>
        <p className="text-sm text-muted-foreground">
          <FormattedMessage
            id="oauthDevice.ready.subtitle"
            defaultMessage="wants to sign in as you"
          />
        </p>
        {clientDomain && <p className="text-xs text-muted-foreground/70">{clientDomain}</p>}
        <p className="mt-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
          <FormattedMessage
            id="oauthDevice.ready.unverified"
            defaultMessage="Unverified application. Anyone can register an app under any name."
          />
        </p>
      </div>

      <div className="rounded-xl border border-border/50 bg-card px-4 py-3 text-center">
        <p className="text-xs text-muted-foreground">
          <FormattedMessage
            id="oauthDevice.ready.codeLabel"
            defaultMessage="Code shown on your device"
          />
        </p>
        <p className="mt-1 font-mono text-2xl font-semibold tracking-[0.3em]">{request.userCode}</p>
      </div>
      <p className="text-center text-xs text-muted-foreground">
        <FormattedMessage
          id="oauthDevice.ready.warning"
          defaultMessage="Approve only if you started this yourself and the code matches. Whoever holds the code can act as you."
        />
      </p>

      {needsChoice && (
        <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
          <DomainAccessPicker
            levels={levels}
            onChange={setLevels}
            allowed={allowed}
            disabled={submitting !== null}
          />
          {asksToStay && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border/30">
              <div className="min-w-0 pr-4">
                <p className="text-sm font-medium">
                  <FormattedMessage
                    id="oauthDevice.ready.stayTitle"
                    defaultMessage="Stay signed in"
                  />
                </p>
                <p className="text-xs text-muted-foreground">
                  <FormattedMessage
                    id="oauthDevice.ready.stayHint"
                    defaultMessage="Let {client} refresh access without asking again"
                    values={{ client: clientName }}
                  />
                </p>
              </div>
              <Switch
                checked={stay}
                onCheckedChange={setStay}
                disabled={submitting !== null}
                aria-label={intl.formatMessage({
                  id: 'oauthDevice.ready.stayTitle',
                  defaultMessage: 'Stay signed in',
                })}
              />
            </div>
          )}
        </div>
      )}

      {problem && (
        <div
          role="alert"
          className="rounded-md bg-destructive/10 p-3 text-center text-sm text-destructive"
        >
          <ProblemMessage reason={problem} />
          {(problem === 'error' || problem === 'rate_limited') && (
            <button type="button" className="ml-2 underline" onClick={onRetry}>
              <FormattedMessage id="oauthDevice.retry" defaultMessage="Try again" />
            </button>
          )}
        </div>
      )}

      <div className="flex gap-3">
        <Button
          variant="outline"
          size="lg"
          className="flex-1"
          disabled={submitting !== null}
          onClick={() => void decide(false)}
        >
          {submitting === 'deny' ? (
            <FormattedMessage id="oauthDevice.ready.denying" defaultMessage="Denying..." />
          ) : (
            <FormattedMessage id="oauthDevice.ready.deny" defaultMessage="Deny" />
          )}
        </Button>
        <Button
          size="lg"
          className="flex-1"
          disabled={submitting !== null || (needsChoice && selected.length === 0)}
          onClick={() => void decide(true)}
        >
          {submitting === 'accept' ? (
            <FormattedMessage id="oauthDevice.ready.approving" defaultMessage="Approving..." />
          ) : (
            <FormattedMessage id="oauthDevice.ready.approve" defaultMessage="Approve" />
          )}
        </Button>
      </div>

      <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground/60">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <p>
          <FormattedMessage
            id="oauthDevice.ready.revoke"
            defaultMessage="Revoke any time in account settings"
          />
        </p>
      </div>
    </Shell>
  )
}

export function DeviceApproval({
  userCode,
  onCode,
}: {
  userCode: string | undefined
  onCode: (code: string) => void
}) {
  const [lookup, setLookup] = useState<DeviceCodeLookup | 'error' | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!userCode) return
    let cancelled = false
    setLookup(null)
    lookupDeviceCodeFn({ data: { userCode } })
      .then((result) => {
        if (!cancelled) setLookup(result)
      })
      .catch(() => {
        if (!cancelled) setLookup('error')
      })
    return () => {
      cancelled = true
    }
  }, [userCode, attempt])

  if (!userCode) return <EnterCode onSubmit={onCode} />

  if (lookup === null) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3">
          <div className="h-11 w-11 rounded-full bg-muted animate-pulse" />
          <div className="h-5 w-52 rounded-md bg-muted animate-pulse" />
        </div>
      </Shell>
    )
  }

  if (lookup !== 'error' && lookup.state === 'ready') {
    return <Approval request={lookup} onRetry={() => setAttempt((n) => n + 1)} />
  }

  const reason =
    lookup === 'error'
      ? 'error'
      : lookup.state === 'settled'
        ? 'settled'
        : (lookup.state as DeviceDecisionRefusal)
  return (
    <Shell>
      <Notice
        tone="bad"
        title={
          <FormattedMessage
            id="oauthDevice.problem.title"
            defaultMessage="This code can't be used"
          />
        }
        body={<ProblemMessage reason={reason} />}
      />
      <Button variant="outline" size="lg" className="w-full" onClick={() => onCode('')}>
        <FormattedMessage id="oauthDevice.problem.again" defaultMessage="Enter a different code" />
      </Button>
    </Shell>
  )
}
