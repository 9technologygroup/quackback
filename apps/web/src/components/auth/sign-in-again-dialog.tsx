/**
 * The sign-in-again dialog. Driven by `useSignInAgain`, it offers the person
 * their own sign-in only: their identity provider (a same-tab redirect that
 * comes back to this page), or the ordinary sign-in form with their address
 * locked. It adds no sign-in UI of its own beyond the provider buttons.
 */
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { defineMessages, FormattedMessage, useIntl } from 'react-intl'
import { ArrowPathIcon } from '@heroicons/react/24/solid'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/shared/spinner'
import { FormError } from '@/components/shared/form-error'
import { AUTH_PROVIDER_ICON_MAP } from '@/components/icons/social-provider-icons'
import { useAuthBroadcast } from '@/lib/client/hooks/use-auth-broadcast'
import { signOut } from '@/lib/client/auth-client'
import type { SignInAgainDialogProps } from '@/lib/client/hooks/use-sign-in-again'
import type { SignInAgainProvider } from '@/lib/shared/sign-in-again'
import type { AuthFormStep } from './email-signin-types'

// The form carries every sign-in step; it loads when the dialog first needs it.
const PortalAuthFormInline = lazy(() =>
  import('./portal-auth-form-inline').then((m) => ({ default: m.PortalAuthFormInline }))
)

const messages = defineMessages({
  title: { id: 'portal.auth.signInAgain.title', defaultMessage: 'Sign in again' },
  description: {
    id: 'portal.auth.signInAgain.description',
    defaultMessage: 'For your security, sign in again to approve this change.',
  },
  differentAccount: {
    id: 'portal.auth.signInAgain.differentAccount',
    defaultMessage: 'You signed in with a different account, so nothing was changed.',
  },
  failed: {
    id: 'portal.auth.error.generic',
    defaultMessage: 'Something went wrong. Please try again.',
  },
  retry: { id: 'portal.auth.tryAgain', defaultMessage: 'Try again' },
})

export function SignInAgainDialog({
  open,
  options,
  loadFailed,
  onRetry,
  notice,
  returnUrl,
  onOpenChange,
  onSignInFinished,
  onProvider,
}: SignInAgainDialogProps) {
  const intl = useIntl()
  const [step, setStep] = useState<AuthFormStep>('credentials')
  const [leavingFor, setLeavingFor] = useState<string | null>(null)
  const [providerFailed, setProviderFailed] = useState(false)

  // A sign-in in the form announces itself the way every sign-in does.
  useAuthBroadcast({ onSuccess: onSignInFinished, enabled: open })

  // The emailed link signs this browser in from the tab it opens. Check again
  // each time this tab comes back to the front while the code is awaited.
  useEffect(() => {
    if (!open || step !== 'code') return
    const check = () => {
      if (document.visibilityState === 'visible') onSignInFinished()
    }
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => {
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
    }
  }, [open, step, onSignInFinished])

  const onContextChange = useCallback((ctx: { step: AuthFormStep }) => setStep(ctx.step), [])

  const handleOpenChange = (next: boolean) => {
    if (!next && (step === 'two-factor-enroll' || step === 'two-factor-challenge')) {
      // Leaving halfway through two-factor must not leave a session that
      // skipped it, as in the sign-in dialog. The page then needs a full
      // sign-in, so it reloads.
      void signOut()
        .catch(() => {})
        .finally(() => window.location.reload())
    }
    if (!next) {
      setStep('credentials')
      setLeavingFor(null)
      setProviderFailed(false)
    }
    onOpenChange(next)
  }

  const startProvider = async (provider: SignInAgainProvider) => {
    setProviderFailed(false)
    setLeavingFor(provider.id)
    const left = await onProvider(provider)
    if (!left) {
      setProviderFailed(true)
      setLeavingFor(null)
    }
  }

  const differentAccount = notice === 'differentAccount'
  const showError = notice === 'failed' || providerFailed

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <FormattedMessage {...messages.title} />
          </DialogTitle>
          <DialogDescription>
            <FormattedMessage
              {...(differentAccount ? messages.differentAccount : messages.description)}
            />
          </DialogDescription>
        </DialogHeader>
        {differentAccount ? null : !options && loadFailed ? (
          <div className="space-y-4">
            <FormError message={intl.formatMessage(messages.failed)} />
            <Button type="button" variant="outline" className="w-full" onClick={onRetry}>
              <FormattedMessage {...messages.retry} />
            </Button>
          </div>
        ) : !options ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : (
          <div className="space-y-6">
            {showError && <FormError message={intl.formatMessage(messages.failed)} />}
            {options.providers.length > 0 && (
              <div className="space-y-3">
                {options.providers.map((provider) => {
                  const Icon = AUTH_PROVIDER_ICON_MAP[provider.id]
                  return (
                    <Button
                      key={provider.id}
                      type="button"
                      variant="outline"
                      className="w-full"
                      disabled={leavingFor !== null}
                      onClick={() => void startProvider(provider)}
                    >
                      {leavingFor === provider.id ? (
                        <ArrowPathIcon className="h-5 w-5 animate-spin" />
                      ) : Icon ? (
                        <Icon className="h-5 w-5" />
                      ) : null}
                      <FormattedMessage
                        id="portal.auth.oauth.signInWith"
                        defaultMessage="Sign in with {provider}"
                        values={{ provider: provider.name }}
                      />
                    </Button>
                  )
                })}
              </div>
            )}
            {options.providers.length > 0 && options.emailMethods && (
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="bg-background px-2 text-muted-foreground">
                    <FormattedMessage id="portal.auth.dividerOr" defaultMessage="or" />
                  </span>
                </div>
              </div>
            )}
            {options.emailMethods && (
              <Suspense
                fallback={
                  <div className="flex justify-center py-10">
                    <Spinner />
                  </div>
                }
              >
                <PortalAuthFormInline
                  mode="login"
                  authConfig={{
                    found: true,
                    oauth: {
                      password: options.emailMethods.password,
                      magicLink: options.emailMethods.magicLink,
                    },
                    twoFactorRequired: options.emailMethods.twoFactorRequired,
                  }}
                  callbackUrl={returnUrl}
                  lockedEmail={options.email}
                  onContextChange={onContextChange}
                />
              </Suspense>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
