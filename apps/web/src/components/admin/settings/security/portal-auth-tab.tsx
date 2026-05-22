import { useState, useTransition, useRef, useCallback } from 'react'
import { useRouter } from '@tanstack/react-router'
import {
  ArrowPathIcon,
  EnvelopeIcon,
  GlobeAltIcon,
  KeyIcon,
  ShieldCheckIcon,
  LockClosedIcon,
  PlusIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { MethodRow } from '@/components/admin/settings/auth-shared/method-row'
import { OAuthProviderGrid } from '@/components/admin/settings/auth-shared/oauth-provider-grid'
import { AuthProviderCredentialsDialog } from '@/components/admin/settings/portal-auth/auth-provider-credentials-dialog'
import { PortalPrivacyDialog } from '@/components/admin/settings/portal-privacy-dialog'
import { SettingsCard } from '@/components/admin/settings/settings-card'
import { WarningBox } from '@/components/shared/warning-box'
import { AUTH_PROVIDERS } from '@/lib/shared/auth-providers'
import { updatePortalConfigFn } from '@/lib/server/functions/settings'
import { updatePortalAccessFn } from '@/lib/server/functions/portal-access'
import { isPathManagedFromBootstrap } from '@/lib/client/config-file'
import { useRouteContext } from '@tanstack/react-router'
import { cn } from '@/lib/shared/utils'
import type { PortalAuthMethods, PortalConfig } from '@/lib/shared/types/settings'

interface PortalAuthTabProps {
  initialOauth: PortalAuthMethods
  credentialStatus: Record<string, boolean> & { _emailConfigured?: boolean }
  customOidcProviderTier: boolean
  portalConfig: PortalConfig
}

/**
 * Portal sign-in tab inside the unified Authentication page.
 *
 * Mirrors the previous standalone /admin/settings/portal-auth page but
 * inlined here so admins don't have to navigate to two separate places
 * to compare team vs portal config. Uses the same `<OAuthProviderGrid>`
 * the Team tab does — clicking "Configure" on any provider opens the
 * shared `AuthProviderCredentialsDialog` (one row in
 * `platform_credentials` powers both surfaces).
 *
 * Differences from the Team tab:
 *  - No SSO card (SSO is admin-only by design — IdPs typically issue
 *    one client secret per Quackback deployment, scoped to team admins
 *    rather than end users).
 *  - Magic Link defaults to off; password defaults to on.
 *  - No enforcement / bootstrap guard — portal is opt-in self-service.
 *
 * The `Sign-in Methods` card includes an explicit info row pointing
 * users to the Team tab for SSO so the absence isn't silent.
 */
// ---------------------------------------------------------------------------
// Visibility option descriptors
// ---------------------------------------------------------------------------

interface VisibilityOption {
  value: 'public' | 'private'
  label: string
  description: string
  icon: typeof LockClosedIcon
}

const VISIBILITY_OPTIONS: VisibilityOption[] = [
  {
    value: 'public',
    label: 'Public',
    description: 'Anyone can view your portal without signing in.',
    icon: GlobeAltIcon,
  },
  {
    value: 'private',
    label: 'Private',
    description: 'Visitors must be authorized to view the portal.',
    icon: LockClosedIcon,
  },
]

export function PortalAuthTab({
  initialOauth,
  credentialStatus,
  customOidcProviderTier,
  portalConfig,
}: PortalAuthTabProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [saving, setSaving] = useState(false)
  const [oauthState, setOauthState] = useState<Record<string, boolean | undefined>>(initialOauth)

  // --- Portal visibility state ---
  const currentVisibility = (portalConfig.access?.visibility ?? 'public') as 'public' | 'private'
  const [visibility, setVisibility] = useState<'public' | 'private'>(currentVisibility)
  const [visibilitySaving, setVisibilitySaving] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pendingVisibility, setPendingVisibility] = useState<'public' | 'private' | null>(null)

  const isVisibilityBusy = visibilitySaving || isPending

  // --- Allowed email domains state ---
  const [allowedDomains, setAllowedDomains] = useState<string[]>(
    portalConfig.access?.allowedDomains ?? []
  )
  const [domainInput, setDomainInput] = useState('')
  const [domainsSaving, setDomainsSaving] = useState(false)
  const [domainInputError, setDomainInputError] = useState<string | null>(null)
  const domainInputRef = useRef<HTMLInputElement>(null)

  const saveDomains = useCallback(
    async (nextDomains: string[]) => {
      const prev = allowedDomains
      setAllowedDomains(nextDomains)
      setDomainsSaving(true)
      try {
        await updatePortalAccessFn({ data: { visibility, allowedDomains: nextDomains } })
        startTransition(() => {
          router.invalidate()
        })
      } catch {
        setAllowedDomains(prev)
      } finally {
        setDomainsSaving(false)
      }
    },
    [allowedDomains, visibility, router, startTransition]
  )

  function handleAddDomain() {
    const raw = domainInput.trim().toLowerCase().replace(/^@/, '')
    if (!raw) return

    // Basic client-side validation matching server normalization rules
    if (raw.includes('://') || raw.includes('@') || /\s/.test(raw) || !raw.includes('.')) {
      setDomainInputError('Enter a valid domain, e.g. acme.com')
      return
    }

    if (allowedDomains.includes(raw)) {
      setDomainInputError('Domain already in the list')
      return
    }

    setDomainInputError(null)
    setDomainInput('')
    void saveDomains([...allowedDomains, raw])
  }

  function handleRemoveDomain(domain: string) {
    void saveDomains(allowedDomains.filter((d) => d !== domain))
  }

  function handleDomainKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddDomain()
    }
  }

  async function applyVisibility(next: 'public' | 'private') {
    const prev = visibility
    setVisibility(next)
    setVisibilitySaving(true)
    try {
      await updatePortalAccessFn({ data: { visibility: next, allowedDomains } })
      startTransition(() => {
        router.invalidate()
      })
    } catch {
      // Revert optimistic update on error
      setVisibility(prev)
    } finally {
      setVisibilitySaving(false)
    }
  }

  function handleVisibilitySelect(next: 'public' | 'private') {
    if (next === visibility || isVisibilityBusy) return

    if (next === 'private') {
      setPendingVisibility('private')
      setDialogOpen(true)
    } else {
      void applyVisibility('public')
    }
  }

  function handleConfirmPrivate() {
    setDialogOpen(false)
    if (pendingVisibility === 'private') {
      setPendingVisibility(null)
      void applyVisibility('private')
    }
  }

  function handleCancelDialog(open: boolean) {
    if (!open) {
      setPendingVisibility(null)
    }
    setDialogOpen(open)
  }

  const { managedFieldPaths = [] } =
    (useRouteContext({ from: '__root__' }) as { managedFieldPaths?: string[] }) ?? {}
  const isManaged = (path: string) => isPathManagedFromBootstrap(path, managedFieldPaths)

  const emailConfigured = credentialStatus._emailConfigured !== false
  const passwordEnabled = oauthState.password ?? true
  const magicLinkEnabled = oauthState.magicLink ?? false

  // Last-enabled-method guard. Portal has no locked-on method, so we
  // refuse to disable the only remaining one. Legacy `email` flag is
  // excluded — migration 0049 retired it in favour of magicLink.
  const enabledMethodCount = Object.entries(oauthState).filter(
    ([k, v]) => v && k !== 'email'
  ).length
  const isLastMethod = (id: string) => !!oauthState[id] && enabledMethodCount === 1

  // Gates on what's *usable* (intent flag AND credentials), not on raw
  // intent — a `google: true` flag with no saved credential renders as
  // a "Not configured" tile and isn't a working sign-in surface.
  const noPortalAuthEnabled = (() => {
    if (oauthState.password) return false
    if (oauthState.magicLink && emailConfigured) return false
    return !Object.entries(oauthState).some(([id, enabled]) => {
      if (!enabled) return false
      if (id === 'password' || id === 'magicLink' || id === 'email') return false
      return !!credentialStatus[id]
    })
  })()

  const save = async (patch: Record<string, boolean | undefined>) => {
    setSaving(true)
    try {
      await updatePortalConfigFn({ data: { oauth: patch } })
      startTransition(() => router.invalidate())
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = (id: string, checked: boolean) => {
    setOauthState((prev) => ({ ...prev, [id]: checked }))
    void save({ [id]: checked })
  }

  const [configDialog, setConfigDialog] = useState<{
    credentialType: string
    providerId: string
    providerName: string
    helpUrl?: string
    fields: (typeof AUTH_PROVIDERS)[number]['platformCredentials']
  } | null>(null)

  const openConfigDialog = (provider: (typeof AUTH_PROVIDERS)[number]) => {
    const helpUrl = provider.platformCredentials.find((f) => f.helpUrl)?.helpUrl
    setConfigDialog({
      credentialType: provider.credentialType,
      providerId: provider.id,
      providerName: provider.name,
      helpUrl,
      fields: provider.platformCredentials,
    })
  }

  return (
    <div className="space-y-6">
      {/* Portal visibility — phase 1 */}
      <SettingsCard
        title="Portal visibility"
        description="Choose whether your portal is open to anyone or restricted to authorized visitors."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {VISIBILITY_OPTIONS.map((option) => {
            const isSelected = visibility === option.value
            const Icon = option.icon
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => handleVisibilitySelect(option.value)}
                disabled={isVisibilityBusy}
                className={cn(
                  'relative flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors',
                  isSelected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border/50 bg-card hover:border-border hover:bg-muted/30',
                  isVisibilityBusy && 'cursor-not-allowed opacity-60'
                )}
              >
                <div className="flex items-center gap-2">
                  <Icon
                    className={cn(
                      'h-4 w-4 shrink-0',
                      isSelected ? 'text-primary' : 'text-muted-foreground'
                    )}
                  />
                  <span className="text-sm font-medium">{option.label}</span>
                  {visibilitySaving && isSelected && (
                    <ArrowPathIcon className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{option.description}</p>
              </button>
            )
          })}
        </div>
      </SettingsCard>

      {/* Allowed email domains — only meaningful for a private portal */}
      {visibility === 'private' && (
        <SettingsCard
          title="Allowed email domains"
          description="Signed-in users with a verified email on these domains can access the private portal."
        >
          <div className="space-y-4">
            <div className="flex gap-2">
              <div className="flex-1">
                <Input
                  ref={domainInputRef}
                  value={domainInput}
                  onChange={(e) => {
                    setDomainInput(e.target.value)
                    if (domainInputError) setDomainInputError(null)
                  }}
                  onKeyDown={handleDomainKeyDown}
                  placeholder="acme.com"
                  disabled={domainsSaving}
                  aria-label="Add email domain"
                  aria-invalid={!!domainInputError}
                  className={cn(domainInputError && 'border-destructive')}
                />
                {domainInputError && (
                  <p className="mt-1 text-xs text-destructive">{domainInputError}</p>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddDomain}
                disabled={!domainInput.trim() || domainsSaving}
                className="h-9 shrink-0"
              >
                <PlusIcon className="mr-1 h-3.5 w-3.5" />
                Add
              </Button>
              {domainsSaving && (
                <div className="flex items-center">
                  <ArrowPathIcon className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>

            {allowedDomains.length > 0 ? (
              <ul className="space-y-1.5" role="list" aria-label="Allowed domains">
                {allowedDomains.map((domain) => (
                  <li
                    key={domain}
                    className="flex items-center justify-between rounded-md border border-border/50 bg-muted/30 px-3 py-1.5"
                  >
                    <span className="text-sm font-mono">{domain}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveDomain(domain)}
                      disabled={domainsSaving}
                      className="ml-2 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40 transition-colors"
                      aria-label={`Remove ${domain}`}
                    >
                      <XMarkIcon className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">
                No domains added yet. Anyone signed in must be a team member to access the portal.
              </p>
            )}
          </div>
        </SettingsCard>
      )}

      <PortalPrivacyDialog
        open={dialogOpen}
        onOpenChange={handleCancelDialog}
        onConfirm={handleConfirmPrivate}
      />

      {noPortalAuthEnabled && (
        <WarningBox
          variant="warning"
          title="No portal sign-in enabled"
          description={
            <>
              Visitors can&apos;t sign in or sign up on your portal. Your team can still sign in at{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">/admin</code>.
            </>
          }
        />
      )}

      {/* Card — Sign-in Methods */}
      <div className="rounded-xl border border-border/50 bg-card shadow-sm">
        <div className="px-6 py-4 border-b border-border/50">
          <h2 className="text-base font-semibold">Sign-in methods</h2>
          <p className="text-xs text-muted-foreground mt-1">
            How visitors sign in to your public feedback portal.
          </p>
        </div>
        <div className="p-6 space-y-4">
          <MethodRow
            icon={KeyIcon}
            label="Password"
            description="Sign in with email and password."
            checked={passwordEnabled}
            onCheckedChange={(v) => handleToggle('password', v)}
            disabled={
              saving ||
              isPending ||
              isManaged('portalConfig.oauth.password') ||
              (passwordEnabled && enabledMethodCount === 1)
            }
            badge={isManaged('portalConfig.oauth.password') ? 'Managed' : undefined}
            badgeTooltip={
              isManaged('portalConfig.oauth.password')
                ? 'Managed by your configuration file.'
                : undefined
            }
          />
          <MethodRow
            icon={EnvelopeIcon}
            label="Email magic link"
            description={
              emailConfigured
                ? 'One-click link or 6-digit code by email.'
                : 'Configure SMTP or Resend to enable email delivery.'
            }
            checked={magicLinkEnabled}
            onCheckedChange={(v) => handleToggle('magicLink', v)}
            disabled={
              saving ||
              isPending ||
              !emailConfigured ||
              isManaged('portalConfig.oauth.magicLink') ||
              (magicLinkEnabled && enabledMethodCount === 1)
            }
          />
        </div>
      </div>

      {/* Card — OAuth Providers (portal-side toggles) */}
      <div className="rounded-xl border border-border/50 bg-card shadow-sm">
        <div className="px-6 py-4 border-b border-border/50">
          <h2 className="text-base font-semibold">Social sign-in</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Let visitors sign in with Google, GitHub, and more. Configure each provider once and
            enable it for the Team or Portal.
          </p>
        </div>
        <div className="p-6">
          <OAuthProviderGrid
            enabled={oauthState}
            credentialStatus={credentialStatus}
            isLastMethod={isLastMethod}
            isManaged={(id) => isManaged(`portalConfig.oauth.${id}`)}
            saving={saving || isPending}
            onToggle={handleToggle}
            onConfigure={openConfigDialog}
            excludeProviderIds={['custom-oidc']}
          />
        </div>
      </div>

      {/* Card — Custom OIDC (own surface; not in the social grid) */}
      <CustomOidcCard
        configured={!!credentialStatus['custom-oidc']}
        enabled={!!oauthState['custom-oidc']}
        managed={isManaged('portalConfig.oauth.custom-oidc')}
        lastMethod={isLastMethod('custom-oidc')}
        tierEnabled={customOidcProviderTier}
        saving={saving || isPending}
        onToggle={(v) => handleToggle('custom-oidc', v)}
        onConfigure={() => {
          // Look up by provider id (not credentialType — that's what
          // `getAuthProvider(...)` takes). Inline lookup avoids the wrong
          // helper.
          const provider = AUTH_PROVIDERS.find((p) => p.id === 'custom-oidc')
          if (provider) openConfigDialog(provider)
        }}
      />

      {(saving || isPending) && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ArrowPathIcon className="h-4 w-4 animate-spin" />
          <span>Saving…</span>
        </div>
      )}

      {configDialog && (
        <AuthProviderCredentialsDialog
          credentialType={configDialog.credentialType}
          providerId={configDialog.providerId}
          providerName={configDialog.providerName}
          helpUrl={configDialog.helpUrl}
          fields={configDialog.fields}
          open={!!configDialog}
          onOpenChange={(open) => !open && setConfigDialog(null)}
        />
      )}
    </div>
  )
}

interface CustomOidcCardProps {
  configured: boolean
  enabled: boolean
  managed: boolean
  lastMethod: boolean
  tierEnabled: boolean
  saving: boolean
  onToggle: (next: boolean) => void
  onConfigure: () => void
}

/**
 * Dedicated card for custom OIDC. Separated from the alphabetical social
 * grid because bring-your-own-IdP is a different shape of setup than a
 * social tile — there's a discovery URL, a client secret, and tier gating
 * to surface. Industry convention (Linear, Notion, Auth0, Clerk, WorkOS,
 * Stytch) splits Social vs Enterprise SSO into distinct sections.
 *
 * Three states drive the layout, in priority order:
 *  - `!tierEnabled`: tier-locked. Lock badge + upgrade hint; Configure is
 *    disabled, no toggle (nothing to toggle into).
 *  - `!configured`: no credentials yet. Primary "Set up" CTA, no toggle.
 *  - `configured`: outlined Edit button + the enable switch, mirroring
 *    the "configured" half of the social grid tiles.
 */
function CustomOidcCard({
  configured,
  enabled,
  managed,
  lastMethod,
  tierEnabled,
  saving,
  onToggle,
  onConfigure,
}: CustomOidcCardProps) {
  const headerBadge = (() => {
    if (!tierEnabled) {
      return (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
          <LockClosedIcon className="mr-1 h-2.5 w-2.5" />
          Higher tier
        </Badge>
      )
    }
    if (!configured) return null
    if (enabled) {
      return (
        <Badge
          variant="outline"
          className="border-green-500/30 text-green-600 text-[10px] px-1.5 py-0"
        >
          <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-green-600" />
          Active
        </Badge>
      )
    }
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
        Configured
      </Badge>
    )
  })()

  return (
    <div className="rounded-xl border border-border/50 bg-card shadow-sm">
      <div className="flex items-start gap-4 p-6">
        <div
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
            tierEnabled ? 'bg-violet-600/10' : 'bg-muted'
          )}
        >
          <ShieldCheckIcon
            className={cn('h-5 w-5', tierEnabled ? 'text-violet-600' : 'text-muted-foreground/60')}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">Custom identity provider</h2>
            {headerBadge}
          </div>
          <p className="mt-1 max-w-xl text-xs text-muted-foreground">
            Let portal users sign in via your own IdP. Works with any OpenID Connect provider —
            Okta, Azure AD, Auth0, Keycloak, and more.
          </p>

          {!tierEnabled ? (
            <p className="mt-4 text-xs text-muted-foreground">
              Available on plans with the custom OIDC feature.
            </p>
          ) : !configured ? (
            <div className="mt-4">
              <Button
                type="button"
                size="sm"
                onClick={onConfigure}
                disabled={managed}
                className="h-9"
              >
                Set up custom OIDC
              </Button>
            </div>
          ) : (
            <div className="mt-4 flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onConfigure}
                disabled={managed}
                className="h-9"
              >
                Edit configuration
              </Button>
              {managed && (
                <span className="text-xs text-muted-foreground">
                  Managed by your configuration file.
                </span>
              )}
            </div>
          )}
        </div>
        {tierEnabled && configured && (
          <div className="shrink-0">
            <Switch
              id="custom-oidc-toggle"
              checked={enabled}
              onCheckedChange={onToggle}
              disabled={saving || managed || lastMethod}
              aria-label="Enable custom OIDC for the portal"
            />
          </div>
        )}
      </div>
    </div>
  )
}
