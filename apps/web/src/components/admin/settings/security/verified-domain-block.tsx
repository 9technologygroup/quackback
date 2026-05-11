import { useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { CheckCircleIcon, ClockIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/solid'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { WarningBox } from '@/components/shared/warning-box'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { CopyButton } from '@/components/shared/copy-button'
import { TimeAgo } from '@/components/ui/time-ago'
import { settingsQueries } from '@/lib/client/queries/settings'
import { adminQueries } from '@/lib/client/queries/admin'
import {
  addVerifiedDomainFn,
  removeVerifiedDomainFn,
  verifyDomainFn,
  setVerifiedDomainEnforcedFn,
  type VerifyDomainResult,
} from '@/lib/server/functions/sso'
import type { VerifiedDomain } from '@/lib/server/domains/settings/settings.types'

const MAX_VERIFIED_DOMAINS = 10

const VERIFY_REASON_MESSAGES: Record<
  Exclude<VerifyDomainResult, { verified: true }>['reason'],
  string
> = {
  'no-record':
    "Couldn't find a TXT record at that name. Add the record above and wait for DNS propagation, then try again.",
  mismatch:
    "Found a TXT record but the value didn't match. Double-check the value (it should start with `qb-domain-verify=`).",
  'lookup-failed': 'DNS lookup failed. Try again in a moment.',
  'no-pending-domain': 'No pending domain to verify.',
}

/**
 * Verified-domain list rendered as a table — replaces the old single-
 * domain UI. Each row shows status, per-row "Require SSO" toggle, and
 * actions. Pending rows expand to show DNS instructions inline.
 *
 * Self-contained data: reads `settingsQueries.verifiedDomains()` and
 * invalidates that key + `ssoStatus` after every mutation.
 */
export function VerifiedDomainBlock() {
  const domainsQuery = useSuspenseQuery(settingsQueries.verifiedDomains())
  const ssoEnabledQuery = useSuspenseQuery(settingsQueries.authConfig())
  const ssoStatusQuery = useSuspenseQuery(adminQueries.ssoStatus())
  const domains = domainsQuery.data ?? []
  const ssoEnabled = ssoEnabledQuery.data?.ssoOidc?.enabled === true
  const bootstrapEligible = ssoStatusQuery.data?.bootstrapEligible ?? false

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Verified domains</h3>
        <p className="text-xs text-muted-foreground">
          Add the email domains your team uses. Once verified, those emails sign in through your SSO
          provider by default. Turn on <b>Require SSO</b> to make it the only option for that
          domain.
        </p>
      </div>

      {!ssoEnabled && domains.length > 0 && (
        <WarningBox
          variant="warning"
          title="SSO is turned off"
          description={
            <>
              These domains will start using SSO once you turn on <strong>Enabled</strong> above.
            </>
          }
        />
      )}

      <div className="rounded-md border border-border/50 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40%]">Domain</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[140px]">Require SSO</TableHead>
              <TableHead className="w-[110px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {domains.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="text-center text-xs text-muted-foreground py-6">
                  No domains yet. Add one below to route those emails to SSO.
                </TableCell>
              </TableRow>
            )}
            {domains.map((d) => (
              <DomainRow key={d.id} domain={d} bootstrapEligible={bootstrapEligible} />
            ))}
          </TableBody>
          <TableFooter className="bg-transparent">
            <AddDomainFooter
              atCap={domains.length >= MAX_VERIFIED_DOMAINS}
              count={domains.length}
            />
          </TableFooter>
        </Table>
      </div>
    </div>
  )
}

function DomainRow({
  domain,
  bootstrapEligible,
}: {
  domain: VerifiedDomain
  bootstrapEligible: boolean
}) {
  const queryClient = useQueryClient()
  const remove = useServerFn(removeVerifiedDomainFn)
  const verify = useServerFn(verifyDomainFn)
  const setEnforced = useServerFn(setVerifiedDomainEnforcedFn)

  const [pending, setPending] = useState(false)
  const [verifyResult, setVerifyResult] = useState<VerifyDomainResult | null>(null)
  const [enforceError, setEnforceError] = useState<string | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [enforceConfirmOpen, setEnforceConfirmOpen] = useState(false)

  const isVerified = domain.verifiedAt !== null

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['settings', 'verifiedDomains'] }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'ssoStatus'] }),
    ])
  }

  async function handleVerify() {
    setVerifyResult(null)
    setPending(true)
    try {
      const r = await verify({ data: { id: domain.id } })
      setVerifyResult(r)
      if (r.verified) await refresh()
    } catch {
      setVerifyResult({ verified: false, reason: 'lookup-failed' })
    } finally {
      setPending(false)
    }
  }

  async function handleRemove() {
    setPending(true)
    try {
      await remove({ data: { id: domain.id } })
      await refresh()
    } finally {
      setPending(false)
      setRemoveOpen(false)
    }
  }

  async function applyEnforced(next: boolean) {
    setEnforceError(null)
    setPending(true)
    try {
      await setEnforced({ data: { id: domain.id, enforced: next } })
      await refresh()
    } catch (err) {
      setEnforceError(err instanceof Error ? err.message : 'Could not change enforcement.')
    } finally {
      setPending(false)
      setEnforceConfirmOpen(false)
    }
  }

  const enforcementDisabledReason = !isVerified
    ? 'Verify this domain first.'
    : !bootstrapEligible
      ? 'Sign in via SSO first to enable enforcement.'
      : null

  return (
    <>
      <TableRow>
        <TableCell className="font-medium align-top">
          <div className="flex items-center gap-2">
            {isVerified ? (
              <CheckCircleIcon className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
            ) : (
              <ClockIcon className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            )}
            <span className="truncate">{domain.name}</span>
          </div>
        </TableCell>

        <TableCell className="text-xs text-muted-foreground align-top">
          {isVerified ? (
            <span>
              Verified <TimeAgo date={domain.verifiedAt!} />
            </span>
          ) : (
            <span>Pending verification</span>
          )}
        </TableCell>

        <TableCell className="align-top">
          {isVerified && (
            <Switch
              checked={domain.enforced}
              onCheckedChange={(next) => {
                if (next) {
                  setEnforceConfirmOpen(true)
                } else {
                  void applyEnforced(false)
                }
              }}
              disabled={pending || (!domain.enforced && !!enforcementDisabledReason)}
              aria-label={`Require SSO for ${domain.name}`}
            />
          )}
        </TableCell>

        <TableCell className="text-right align-top">
          <div className="flex justify-end gap-1">
            {!isVerified && (
              <Button size="sm" variant="secondary" onClick={handleVerify} disabled={pending}>
                {pending ? 'Verifying…' : 'Verify'}
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setRemoveOpen(true)}
              disabled={pending}
              aria-label={`Remove ${domain.name}`}
              title={`Remove ${domain.name}`}
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
            >
              <TrashIcon className="h-4 w-4" />
            </Button>
          </div>
        </TableCell>
      </TableRow>

      {!isVerified && (
        <TableRow className="border-t-0 hover:bg-transparent">
          <TableCell colSpan={4} className="bg-muted/30 py-3">
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Add this DNS TXT record at your registrar, then click <b>Verify</b>:
              </p>
              <DnsRecordRow label="Name" value={`_quackback-verify.${domain.name}`} />
              <DnsRecordRow label="Value" value={`qb-domain-verify=${domain.verificationToken}`} />
              <DnsRecordRow
                label="Check"
                value={`dig +short TXT _quackback-verify.${domain.name}`}
              />
              {verifyResult && !verifyResult.verified && (
                <Alert variant="destructive">
                  <AlertDescription className="text-xs">
                    {VERIFY_REASON_MESSAGES[verifyResult.reason]}
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}

      {isVerified && (enforcementDisabledReason || enforceError) && !domain.enforced && (
        <TableRow className="border-t-0 hover:bg-transparent">
          <TableCell colSpan={4} className="bg-muted/30 py-2">
            {enforceError && (
              <Alert variant="destructive">
                <AlertDescription className="text-xs">{enforceError}</AlertDescription>
              </Alert>
            )}
            {enforcementDisabledReason && !enforceError && (
              <p className="text-[11px] text-muted-foreground">{enforcementDisabledReason}</p>
            )}
          </TableCell>
        </TableRow>
      )}

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={`Remove ${isVerified ? 'verified' : 'pending'} domain?`}
        description={
          isVerified
            ? `Stops routing *@${domain.name} emails to SSO and disables hard-binding.`
            : `Discards the pending verification token for ${domain.name}.`
        }
        variant="destructive"
        confirmLabel="Remove"
        isPending={pending}
        onConfirm={handleRemove}
      />
      <ConfirmDialog
        open={enforceConfirmOpen}
        onOpenChange={setEnforceConfirmOpen}
        title={`Require SSO for ${domain.name}?`}
        description={`*@${domain.name} will only be able to sign in via SSO. Keep one admin at a different domain so you can recover if your IdP goes down.`}
        warning={{
          title: 'This takes effect immediately.',
        }}
        confirmLabel="Require SSO"
        isPending={pending}
        onConfirm={() => applyEnforced(true)}
      />
    </>
  )
}

/**
 * Table-footer row for adding a new domain. Two states:
 *  - Collapsed: a single `+ Add domain` cell that spans the table.
 *  - Editing: input + Add / Cancel, with optional inline error.
 *
 * Keeps the add affordance inside the table itself (no separate form
 * below) so the "list of domains" reads as a single object.
 */
function AddDomainFooter({ atCap, count }: { atCap: boolean; count: number }) {
  const queryClient = useQueryClient()
  const addDomain = useServerFn(addVerifiedDomainFn)
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  const reset = () => {
    setDraftName('')
    setError('')
    setEditing(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!draftName.trim()) return
    setError('')
    setPending(true)
    try {
      await addDomain({ data: { name: draftName.trim() } })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['settings', 'verifiedDomains'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'ssoStatus'] }),
      ])
      reset()
    } catch (err) {
      setError((err as Error).message || 'Could not add domain.')
    } finally {
      setPending(false)
    }
  }

  if (!editing) {
    return (
      <TableRow className="hover:bg-muted/40">
        <TableCell colSpan={4} className="p-0">
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={atCap}
            className="flex w-full items-center justify-between px-4 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="flex items-center gap-2">
              <PlusIcon className="h-3.5 w-3.5" />
              Add domain
            </span>
            <span>
              {count} of {MAX_VERIFIED_DOMAINS}
              {atCap && ' (limit reached)'}
            </span>
          </button>
        </TableCell>
      </TableRow>
    )
  }

  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={4} className="bg-muted/30">
        <form onSubmit={handleSubmit} className="space-y-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="add-verified-domain" className="sr-only">
              Domain
            </Label>
            <Input
              id="add-verified-domain"
              placeholder="acme.com"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && !pending) reset()
              }}
              disabled={pending}
              autoFocus
              className="h-9"
            />
            <Button type="submit" disabled={pending || !draftName.trim()} size="sm">
              {pending ? 'Adding…' : 'Add'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={pending}>
              Cancel
            </Button>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}
        </form>
      </TableCell>
    </TableRow>
  )
}

function DnsRecordRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-xs text-muted-foreground uppercase">{label}</span>
      <code className="flex-1 truncate rounded bg-background px-2 py-1 text-xs">{value}</code>
      <CopyButton value={value} aria-label={`Copy ${label}`} />
    </div>
  )
}
