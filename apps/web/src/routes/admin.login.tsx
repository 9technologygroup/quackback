import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { PortalAuthForm } from '@/components/auth/portal-auth-form'
import { SsoSignInButton } from '@/components/auth/sso-sign-in-button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronDownIcon, ExclamationCircleIcon } from '@heroicons/react/24/solid'
import { useState } from 'react'

// Error messages for login failures
const errorMessages: Record<string, string> = {
  invalid_token: 'Your login link is invalid or has been tampered with. Please try again.',
  token_expired: 'Your login link has expired. Please request a new one.',
  not_team_member:
    "This account doesn't have team access. Team membership is by invitation only. Please contact your administrator.",
  oauth_method_not_allowed: 'This sign-in method is not enabled for team members.',
  password_method_not_allowed: 'Password sign-in is not enabled. Please use another method.',
}

const searchSchema = z.object({
  callbackUrl: z.string().optional(),
  error: z.string().optional(),
})

/**
 * Admin Login Page
 *
 * For team members (admin, member) to sign in to the admin dashboard.
 * Supports email OTP and any configured OAuth providers.
 *
 * When OIDC SSO is enabled (settings.authConfig.ssoOidc) AND the `sso`
 * provider is actually registered by Better-Auth (per
 * BootstrapData.registeredAuthProviders — covers the case where the
 * client secret hasn't materialized in env yet), "Sign in with
 * {providerName}" becomes the prominent CTA. Password / magic-link /
 * other-OAuth options stay rendered behind a "More sign-in options"
 * disclosure so admins keep a working fallback.
 */
export const Route = createFileRoute('/admin/login')({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ callbackUrl: search.callbackUrl, error: search.error }),
  loader: async ({ deps, context }) => {
    // Settings already available from root context
    const { settings, registeredAuthProviders } = context
    if (!settings) {
      throw redirect({ to: '/onboarding' })
    }

    const { callbackUrl, error } = deps

    // Get error message if present
    const errorMessage = error && errorMessages[error]

    // Validate callbackUrl is a relative path to prevent open redirects
    const safeCallbackUrl =
      callbackUrl && callbackUrl.startsWith('/') && !callbackUrl.startsWith('//')
        ? callbackUrl
        : '/admin'

    // Auth config is already computed in TenantSettings (filtered by configured credentials)
    const authConfig = settings.publicAuthConfig.oauth
    const customProviderNames = settings.publicAuthConfig.customProviderNames

    const ssoOidc = settings.authConfig?.ssoOidc
    const ssoIsRegistered = registeredAuthProviders?.includes('sso') ?? false
    // Both the DB intent AND actual registration must be true. A stale
    // `ssoOidc.enabled=true` whose client secret hasn't arrived in env
    // would otherwise produce a CTA that 404s on click.
    const ssoIsDefault = Boolean(ssoOidc?.enabled) && Boolean(ssoOidc?.isDefault) && ssoIsRegistered
    const ssoProviderName = ssoOidc?.providerName ?? 'SSO'

    return {
      errorMessage,
      safeCallbackUrl,
      authConfig,
      customProviderNames,
      ssoIsDefault,
      ssoProviderName,
    }
  },
  component: AdminLoginPage,
})

/**
 * /admin/login is the team sign-in page. Magic-link is forced on and
 * the password-form is forced off — admins arrive without a password
 * set (workspace owner is created via a magic-link claim, not a
 * password registration), and team members invite-link in the same
 * way. OAuth providers pass through whatever the tenant configured.
 */
function teamSignInAuthConfig(tenantAuthConfig: Record<string, unknown>) {
  return { ...tenantAuthConfig, magicLink: true, password: false }
}

function AdminLoginPage() {
  const {
    errorMessage,
    safeCallbackUrl,
    authConfig,
    customProviderNames,
    ssoIsDefault,
    ssoProviderName,
  } = Route.useLoaderData()

  // Open the "more options" disclosure by default when SSO is NOT the
  // primary CTA, so the admin sees the existing form unchanged.
  const [moreOpen, setMoreOpen] = useState(!ssoIsDefault)

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md space-y-8 px-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Team Sign In</h1>
          <p className="mt-2 text-muted-foreground">Sign in to access the admin dashboard</p>
        </div>
        {errorMessage && (
          <Alert variant="destructive">
            <ExclamationCircleIcon className="h-4 w-4" />
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}
        {ssoIsDefault && (
          <SsoSignInButton providerName={ssoProviderName} callbackUrl={safeCallbackUrl} />
        )}
        <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
          {ssoIsDefault && (
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <span>More sign-in options</span>
                <ChevronDownIcon
                  className={`size-4 transition-transform ${moreOpen ? 'rotate-180' : ''}`}
                />
              </button>
            </CollapsibleTrigger>
          )}
          <CollapsibleContent className="pt-4">
            <PortalAuthForm
              mode="login"
              callbackUrl={safeCallbackUrl}
              authConfig={teamSignInAuthConfig(authConfig)}
              customProviderNames={customProviderNames}
            />
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  )
}
