/**
 * Ask the person to sign in again before a sensitive action, then resume it.
 *
 * A page calls `request(action)` when a server function answers with the
 * recent-sign-in refusal (`isRecentSignInRequired`), and renders
 * `<SignInAgainDialog {...dialog} />`. `action` is a short string the page can
 * resume from, such as `approve:<id>`. `onSignedIn(action)` runs once the
 * server confirms the same person signed in within the window:
 *
 * - straight away, when the sign-in finished in the dialog (password, emailed
 *   code, or the emailed link opened in another tab, noticed when this tab is
 *   back in front);
 * - on landing back on the page, after an identity provider. The page may
 *   still be loading then, so `onSignedIn` should be able to wait for what the
 *   action needs.
 *
 * The person who asked is the one the page was rendered for (the session in
 * the root route context). Nothing resumes without knowing who that is, and a
 * sign-in as anyone else resumes nothing: the dialog says so, and closing it
 * reloads the page as the account now signed in. Use one per page; the action
 * names what to resume.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { authClient } from '@/lib/client/auth-client'
import { getSignInAgainOptionsFn } from '@/lib/server/functions/sign-in-again'
import { useSessionContext } from '@/lib/client/hooks/use-root-context'
import {
  readSignInAgainMarker,
  signInAgainProviderRequest,
  signInAgainReturnUrl,
  stashSignInAgain,
  stripSignInAgainSearch,
  takeSignInAgain,
  withoutSignInAgainMarker,
} from '@/lib/client/sign-in-again'
import type { SignInAgainOptions, SignInAgainProvider } from '@/lib/shared/sign-in-again'

/** Why the dialog shows something other than the sign-in. */
export type SignInAgainNotice = 'failed' | 'differentAccount'

export interface SignInAgainDialogProps {
  open: boolean
  /** How the person signs in; undefined while it loads. */
  options: SignInAgainOptions | undefined
  /** The options could not be read; `onRetry` reads them again. */
  loadFailed: boolean
  onRetry: () => void
  notice: SignInAgainNotice | null
  /** This page, marked with the action, for sign-ins that come back by link. */
  returnUrl: string
  onOpenChange: (open: boolean) => void
  /** A sign-in may have finished; confirms with the server and resumes. */
  onSignInFinished: () => void
  /** Leaves for an identity provider; false when the sign-in could not start. */
  onProvider: (provider: SignInAgainProvider) => Promise<boolean>
}

export interface UseSignInAgainResult {
  request: (action: string) => void
  dialog: SignInAgainDialogProps
}

const OPTIONS_KEY = ['auth', 'sign-in-again'] as const

export function useSignInAgain(options: {
  onSignedIn: (action: string) => void
}): UseSignInAgainResult {
  const queryClient = useQueryClient()
  const router = useRouter()
  const sessionUserId = useSessionContext()?.user?.id ?? null
  const [action, setAction] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<SignInAgainNotice | null>(null)
  // The action waiting on a sign-in. A check claims it (clears this) before it
  // awaits anything, so the several signals one sign-in sends (the tab coming
  // back, its focus, the sign-in broadcast) resume it once at most.
  const pendingRef = useRef<string | null>(null)
  // Bumped by each request and each close, so a check that outlives either
  // neither resumes nor restores what it claimed.
  const generationRef = useRef(0)
  const checkingRef = useRef(false)
  const recheckRef = useRef(false)
  // The person who asked: the page's own session, taken when the request is
  // made. Never read from the sign-in options, which show whoever is signed in
  // by the time they load.
  const askedByRef = useRef<string | null>(null)
  const reloadOnCloseRef = useRef(false)
  const landedRef = useRef(false)
  const onSignedInRef = useRef(options.onSignedIn)
  useEffect(() => {
    onSignedInRef.current = options.onSignedIn
  })

  const query = useQuery({
    queryKey: OPTIONS_KEY,
    queryFn: () => getSignInAgainOptionsFn(),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })

  const readOptions = useCallback(
    () =>
      queryClient.fetchQuery({
        queryKey: OPTIONS_KEY,
        queryFn: () => getSignInAgainOptionsFn(),
        staleTime: 0,
      }),
    [queryClient]
  )

  const reopen = useCallback((pending: string, why: SignInAgainNotice) => {
    setAction(pending)
    setNotice(why)
    setOpen(true)
  }, [])

  /**
   * Confirms the sign-in with the server and resumes the pending action at
   * most once. A signal that arrives while a check is out asks for one more
   * check rather than running its own. Until the server sees a fresh sign-in
   * the action stays pending; after an identity provider there is nothing
   * more to wait for, so the dialog opens again instead.
   */
  const confirm = useCallback(
    async (afterProvider = false): Promise<void> => {
      if (checkingRef.current) {
        recheckRef.current = true
        return
      }
      const pending = pendingRef.current
      if (!pending) return
      pendingRef.current = null
      const generation = generationRef.current
      checkingRef.current = true
      let outcome: 'resume' | 'differentAccount' | 'wait' = 'wait'
      try {
        const current = await readOptions()
        const askedBy = askedByRef.current
        if (askedBy && current.userId !== askedBy) outcome = 'differentAccount'
        else if (askedBy && current.fresh) outcome = 'resume'
      } catch {
        // Unconfirmed: keep waiting.
      } finally {
        checkingRef.current = false
      }
      if (generation !== generationRef.current) return

      if (outcome === 'resume') {
        recheckRef.current = false
        setOpen(false)
        setAction(null)
        setNotice(null)
        onSignedInRef.current(pending)
        return
      }
      if (outcome === 'differentAccount') {
        recheckRef.current = false
        reloadOnCloseRef.current = !afterProvider
        reopen(pending, 'differentAccount')
        return
      }
      pendingRef.current = pending
      if (afterProvider) {
        reopen(pending, 'failed')
        return
      }
      if (recheckRef.current) {
        recheckRef.current = false
        void confirm()
      }
    },
    [readOptions, reopen]
  )

  const request = useCallback(
    (next: string) => {
      generationRef.current += 1
      pendingRef.current = next
      askedByRef.current = sessionUserId
      reloadOnCloseRef.current = false
      setAction(next)
      setNotice(null)
      setOpen(true)
    },
    [sessionUserId]
  )

  const onProvider = useCallback(
    async (provider: SignInAgainProvider) => {
      const person = query.data
      const askedBy = askedByRef.current
      if (!action || !person || !askedBy) return false
      const returnUrl = signInAgainReturnUrl(window.location.href, action)
      stashSignInAgain({ action, userId: askedBy })
      try {
        // Calls the client directly rather than through `startOidcSignIn`: that
        // helper shares a chunk with eager portal code, and importing it from
        // here would split the chunk and add a request to every portal page.
        const request = signInAgainProviderRequest(provider, person.email, returnUrl)
        const result = await authClient.signIn.social({
          provider: request.providerId,
          callbackURL: request.callbackURL,
          errorCallbackURL: request.errorCallbackURL,
          loginHint: request.loginHint,
        })
        if (!result?.error) return true
      } catch {
        // Reported below, as a sign-in that did not start.
      }
      takeSignInAgain(action)
      return false
    },
    [action, query.data]
  )

  const onOpenChange = useCallback((next: boolean) => {
    if (next) {
      setOpen(true)
      return
    }
    generationRef.current += 1
    pendingRef.current = null
    setOpen(false)
    setAction(null)
    setNotice(null)
    if (reloadOnCloseRef.current) {
      reloadOnCloseRef.current = false
      window.location.assign(withoutSignInAgainMarker(window.location.href))
    }
  }, [])

  const signInFinished = useCallback(() => void confirm(), [confirm])

  // Landing back on the page after an identity provider.
  useEffect(() => {
    if (landedRef.current) return
    landedRef.current = true
    const marker = readSignInAgainMarker(window.location.href)
    if (!marker) return
    // Through the router, so its location loses the marker along with the address bar.
    void router.navigate({
      to: '.',
      search: (search: Record<string, unknown>) => stripSignInAgainSearch(search),
      replace: true,
      resetScroll: false,
    })
    const stash = takeSignInAgain(marker.action)
    if (!stash) return
    generationRef.current += 1
    askedByRef.current = stash.userId
    if (marker.error) {
      pendingRef.current = stash.action
      reopen(stash.action, 'failed')
      return
    }
    pendingRef.current = stash.action
    void confirm(true)
  }, [confirm, reopen, router])

  return {
    request,
    dialog: {
      open,
      options: query.data,
      loadFailed: query.isError && !query.isFetching,
      onRetry: () => void query.refetch(),
      notice,
      returnUrl: action && open ? signInAgainReturnUrl(window.location.href, action) : '',
      onOpenChange,
      onSignInFinished: signInFinished,
      onProvider,
    },
  }
}
