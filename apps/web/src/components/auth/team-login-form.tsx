import { useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { FormError } from '@/components/shared/form-error'
import { ArrowPathIcon, ShieldCheckIcon } from '@heroicons/react/24/solid'
import { authClient } from '@/lib/client/auth-client'
import { lookupAuthMethodsFn, SSO_UNAVAILABLE_MESSAGE } from '@/lib/server/functions/auth'
import { PortalAuthForm } from './portal-auth-form'
import type { PortalAuthMethods } from '@/lib/shared/types'

interface TeamLoginFormProps {
  callbackUrl: string
  /** Team-side auth config from the loader — passed straight through
   *  to `<PortalAuthForm>` once the user's email is known not to match
   *  the verified SSO domain. */
  authConfig: PortalAuthMethods
}

/**
 * Two-stage sign-in dispatcher for `/admin/login`:
 *
 *  Stage 1 (`email`): user types their email and clicks Continue.
 *    The server (`lookupAuthMethodsFn`) classifies by domain match
 *    against the tenant's verified SSO domain — never by account
 *    presence, so this endpoint doesn't leak whether an account
 *    exists at the supplied email.
 *
 *  Stage 2:
 *    - `sso-redirect` → SSO is required (enforcement on + verified
 *      domain match); navigate straight to the IdP, no escape hatch.
 *    - `sso-default` → verified-domain match without enforcement;
 *      offer SSO as the primary CTA but let the user fall back to the
 *      methods form ("Sign in another way").
 *    - `methods` → no domain match; render `<PortalAuthForm>` with the
 *      email pre-filled so the user doesn't retype it.
 */
export function TeamLoginForm({ callbackUrl, authConfig }: TeamLoginFormProps) {
  const lookup = useServerFn(lookupAuthMethodsFn)

  const [stage, setStage] = useState<'email' | 'sso-default' | 'methods'>('email')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [methodsAuthConfig, setMethodsAuthConfig] = useState<PortalAuthMethods>(authConfig)

  function applyMethodsConfig(serverAuthConfig: Record<string, boolean | undefined>) {
    // Bring forward the live config from the server in case it diverged
    // since the loader ran (admin toggling methods mid-session). Magic-link
    // is unconditionally enabled for team sign-in (invitations + SSO
    // break-glass).
    setMethodsAuthConfig({
      ...serverAuthConfig,
      magicLink: true,
      password: serverAuthConfig.password === true,
    })
  }

  async function redirectToSso() {
    // Same-tab redirect to IdP; Better-Auth completes the dance and
    // returns to `callbackUrl` after the post-auth bounce.
    setLoading(true)
    try {
      await authClient.signIn.oauth2({ providerId: 'sso', callbackURL: callbackUrl })
    } catch (err) {
      setError((err as Error).message || 'Could not start SSO sign-in.')
      setLoading(false)
    }
  }

  async function handleContinue(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setError('')
    setLoading(true)
    try {
      const result = await lookup({ data: { email: email.trim(), surface: 'team' } })
      if (result.kind === 'sso-redirect') {
        await authClient.signIn.oauth2({
          providerId: 'sso',
          callbackURL: callbackUrl,
        })
        return
      }
      if (result.kind === 'sso-default') {
        applyMethodsConfig(result.authConfig)
        setStage('sso-default')
        return
      }
      if (result.kind === 'sso-unavailable') {
        // Verified-domain email but SSO isn't registered at runtime —
        // tier downgrade or missing client secret. Under enforcement the
        // other providers are hard-bound so there's no methods fallback.
        setError(SSO_UNAVAILABLE_MESSAGE)
        return
      }
      applyMethodsConfig(result.authConfig)
      setStage('methods')
    } catch (err) {
      setError((err as Error).message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (stage === 'sso-default') {
    return (
      <div className="space-y-4">
        <Button type="button" className="w-full" onClick={redirectToSso} disabled={loading}>
          {loading ? (
            <ArrowPathIcon className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <ShieldCheckIcon className="mr-2 h-4 w-4" />
              Continue with SSO
            </>
          )}
        </Button>
        <button
          type="button"
          onClick={() => setStage('methods')}
          className="block w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          disabled={loading}
        >
          Sign in another way
        </button>
        {error && <FormError message={error} />}
      </div>
    )
  }

  if (stage === 'methods') {
    return (
      <PortalAuthForm
        mode="login"
        callbackUrl={callbackUrl}
        authConfig={methodsAuthConfig}
        initialEmail={email}
      />
    )
  }

  return (
    <form onSubmit={handleContinue} className="space-y-3">
      <Label htmlFor="team-login-email" className="sr-only">
        Work email
      </Label>
      <Input
        id="team-login-email"
        type="email"
        autoComplete="email"
        autoFocus
        placeholder="you@company.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={loading}
        required
      />
      <Button type="submit" className="w-full" disabled={loading || !email.trim()}>
        {loading ? <ArrowPathIcon className="h-4 w-4 animate-spin" /> : 'Continue'}
      </Button>
      {error && <FormError message={error} />}
    </form>
  )
}
