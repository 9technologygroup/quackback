import { useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { FormError } from '@/components/shared/form-error'
import { ArrowPathIcon } from '@heroicons/react/24/solid'
import { authClient } from '@/lib/client/auth-client'
import { lookupAuthMethodsFn, SSO_UNAVAILABLE_MESSAGE } from '@/lib/server/functions/auth'
import { PortalAuthForm } from './portal-auth-form'
import type { PortalAuthMethods } from '@/lib/shared/types'

interface PortalLoginFormProps {
  callbackUrl: string
  /** Portal-side auth config from the loader — passed straight through
   *  to `<PortalAuthForm>` once the user's email is known not to match
   *  the verified SSO domain. */
  authConfig: PortalAuthMethods
  customProviderNames?: Record<string, string>
}

/**
 * Email-first sign-in dispatcher for the public portal (`/auth/login`).
 *
 * Mirrors `<TeamLoginForm>` but for the portal surface — `lookupAuthMethodsFn`
 * is called with `surface: 'portal'` so the methods fallback uses the
 * portal's configured methods, not the team's. The SSO branch is
 * identical: a verified-domain email is hard-bound to SSO regardless of
 * which login page the user came from. The same `handleAutoProvisionAfter`
 * hook then upgrades them to `member` on first SSO sign-in.
 *
 * Magic-link is not force-enabled here (unlike team login where it
 * always is for invitation claims) — the portal honours the admin's
 * tenant-wide magicLink toggle as configured.
 */
export function PortalLoginForm({
  callbackUrl,
  authConfig,
  customProviderNames,
}: PortalLoginFormProps) {
  const lookup = useServerFn(lookupAuthMethodsFn)

  const [stage, setStage] = useState<'email' | 'methods'>('email')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [methodsAuthConfig, setMethodsAuthConfig] = useState<PortalAuthMethods>(authConfig)

  async function handleContinue(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setError('')
    setLoading(true)
    try {
      const result = await lookup({
        data: { email: email.trim(), surface: 'portal' },
      })
      if (result.kind === 'sso-redirect') {
        await authClient.signIn.oauth2({
          providerId: 'sso',
          callbackURL: callbackUrl,
        })
        return
      }
      if (result.kind === 'sso-unavailable') {
        setError(SSO_UNAVAILABLE_MESSAGE)
        return
      }
      setMethodsAuthConfig(result.authConfig)
      setStage('methods')
    } catch (err) {
      setError((err as Error).message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (stage === 'methods') {
    return (
      <PortalAuthForm
        mode="login"
        callbackUrl={callbackUrl}
        authConfig={methodsAuthConfig}
        customProviderNames={customProviderNames}
        initialEmail={email}
      />
    )
  }

  return (
    <form onSubmit={handleContinue} className="space-y-3">
      <Label htmlFor="portal-login-email" className="sr-only">
        Email
      </Label>
      <Input
        id="portal-login-email"
        type="email"
        autoComplete="email"
        autoFocus
        placeholder="you@example.com"
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
