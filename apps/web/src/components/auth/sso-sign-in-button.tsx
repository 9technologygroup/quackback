import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { getOAuthRedirectUrl } from './oauth-buttons'
import {
  openAuthPopup,
  useAuthBroadcast,
  usePopupTracker,
} from '@/lib/client/hooks/use-auth-broadcast'

interface SsoSignInButtonProps {
  providerName: string
  callbackUrl: string
}

/**
 * Primary CTA on the admin login page when OIDC SSO is the default
 * sign-in path. The `sso` provider id is registered by Better-Auth's
 * genericOAuth plugin (see `lib/server/auth/index.ts`); this mirrors
 * the popup flow `OAuthButtons` uses for built-in social providers.
 */
export function SsoSignInButton({ providerName, callbackUrl }: SsoSignInButtonProps) {
  const [loading, setLoading] = useState(false)
  const [popupBlocked, setPopupBlocked] = useState(false)

  const { trackPopup, hasPopup, focusPopup, clearPopup } = usePopupTracker({
    onPopupClosed: () => setLoading(false),
  })

  useAuthBroadcast({
    onSuccess: () => {
      clearPopup()
      setLoading(false)
      window.location.href = callbackUrl
    },
  })

  async function handleClick() {
    if (hasPopup()) {
      focusPopup()
      return
    }
    setLoading(true)
    setPopupBlocked(false)
    const popup = openAuthPopup('about:blank')
    if (!popup) {
      setPopupBlocked(true)
      setLoading(false)
      return
    }
    trackPopup(popup)
    try {
      const url = await getOAuthRedirectUrl(
        { id: 'sso', name: providerName, type: 'generic-oauth' },
        callbackUrl
      )
      if (url) {
        popup.location.href = url
      } else {
        popup.close()
        setLoading(false)
      }
    } catch {
      popup.close()
      setLoading(false)
    }
  }

  return (
    <div className="space-y-2">
      {popupBlocked && (
        <p className="text-sm text-destructive text-center">
          Popup blocked. Please allow popups for this site.
        </p>
      )}
      <Button type="button" size="lg" className="w-full" onClick={handleClick} disabled={loading}>
        {loading ? 'Signing in...' : `Sign in with ${providerName}`}
      </Button>
    </div>
  )
}
