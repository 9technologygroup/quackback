/**
 * SSO test sign-in callback.
 *
 * Popup target the admin's browser is redirected to after the IdP
 * authorize step. The loader hands off to runSsoTestCallbackFn so this
 * route file never directly imports server-only modules (ioredis is
 * specifier-blocked in the client bundle even via dynamic import).
 * Component (client) postMessages the result to the opener and
 * auto-closes on success.
 */

import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'
import { z } from 'zod'
import { runSsoTestCallbackFn } from '@/lib/server/functions/sso-test'

const searchSchema = z.object({
  state: z.string().optional(),
  code: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
})

export const Route = createFileRoute('/admin/sso/test/callback')({
  validateSearch: searchSchema,
  loader: async ({ location }) => {
    const search = searchSchema.parse(location.search)
    return runSsoTestCallbackFn({
      data: {
        state: search.state,
        code: search.code,
        error: search.error,
        errorDescription: search.error_description,
      },
    })
  },
  component: TestCallbackPage,
})

function TestCallbackPage() {
  const { result, testId } = Route.useLoaderData()
  useEffect(() => {
    if (typeof window === 'undefined' || !window.opener) return
    window.opener.postMessage(
      { source: 'quackback-sso-test', testId, result },
      window.location.origin
    )
    // Brief delay so admin sees the result before the popup closes
    // on success. On failure, leave it open for them to read.
    if (result.ok) {
      const t = setTimeout(() => window.close(), 1500)
      return () => clearTimeout(t)
    }
  }, [result, testId])

  return (
    <div className="p-6 max-w-xl mx-auto">
      <h1 className="text-lg font-semibold mb-2">SSO test sign-in</h1>
      {result.ok ? (
        <p className="text-green-600 text-sm">
          Sign-in succeeded. This window will close automatically.
        </p>
      ) : (
        <div className="text-sm">
          <p className="text-destructive font-medium">Test failed at: {result.stage}</p>
          <p className="mt-2 text-muted-foreground">{result.hint}</p>
        </div>
      )}
      <p className="mt-4 text-xs text-muted-foreground">
        You can close this window. Results will appear in the original tab.
      </p>
    </div>
  )
}
