import { useEffect } from 'react'
import { authClient } from '@/lib/client/auth-client'
import { postAuthSuccess } from '@/lib/client/hooks/use-auth-broadcast'

/**
 * Notice a sign-in that finished in another tab. The sign-in email carries a
 * link as well as a code, and opening the link signs this browser in from
 * the tab it opens, which tells nobody: the dialog here would wait on "Check
 * your email" for good.
 *
 * While `enabled`, each time the visitor comes back to this tab the session
 * is read again. A signed-in account (not an anonymous visitor's session) is
 * announced the way a sign-in in this tab is (`postAuthSuccess`), so the
 * dialog closes and runs its `onSuccess`, and the page picks up the session.
 */
export function useSignInFromAnotherTab(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    let active = true
    let checking = false

    const check = async () => {
      if (checking || document.visibilityState !== 'visible') return
      checking = true
      try {
        const { data } = await authClient.getSession()
        const user = data?.user as { isAnonymous?: boolean | null } | undefined
        if (active && user && user.isAnonymous !== true) postAuthSuccess()
      } catch {
        // Still signed out as far as this tab can tell; the next return asks again.
      } finally {
        checking = false
      }
    }

    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => {
      active = false
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
    }
  }, [enabled])
}
