import { createFileRoute } from '@tanstack/react-router'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { getWidgetSession } from '@/lib/server/functions/widget-auth'
import {
  isWidgetAnonCookieEnabled,
  buildWidgetAnonCookie,
} from '@/lib/server/functions/widget-anon-cookie'
import { WIDGET_SESSION_TTL_MS } from '@/lib/server/functions/widget-session-roll'

export const Route = createFileRoute('/api/widget/session')({
  server: {
    handlers: {
      GET: async () => {
        try {
          // `roll: true` extends an active anonymous session's TTL on this
          // validation hit (the widget calls it once per mount), so a returning
          // visitor's session — and thus their conversation — survives past the
          // original 7-day window. Validation-only endpoint; hot paths stay raw.
          const session = await getWidgetSession({ roll: true })
          if (!session) {
            return Response.json(
              { error: { code: 'AUTH_REQUIRED', message: 'Valid widget session required' } },
              { status: 401, headers: noStoreHeaders() }
            )
          }

          const isAnonymous = session.principal.type === 'anonymous'

          const headers: Record<string, string> = { 'Cache-Control': 'no-store' }
          // P2.7: mirror the anonymous localStorage token into a first-party
          // HttpOnly cookie so it survives a same-origin reload that clears
          // localStorage. Only for anon sessions, only when enabled, and only
          // when a Bearer was actually presented (so we never widen scope).
          if (isAnonymous && isWidgetAnonCookieEnabled()) {
            const auth = getRequestHeaders().get('authorization')
            const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null
            if (token) {
              headers['Set-Cookie'] = buildWidgetAnonCookie(
                token,
                Math.floor(WIDGET_SESSION_TTL_MS / 1000)
              )
            }
          }

          return Response.json(
            {
              data: {
                user: isAnonymous
                  ? null
                  : {
                      id: session.user.id,
                      name: session.user.name,
                      email: session.user.email,
                      avatarUrl: session.user.image,
                    },
              },
            },
            { headers }
          )
        } catch (error) {
          console.error('[widget:session] Error:', error)
          return Response.json(
            { error: { code: 'SERVER_ERROR', message: 'Failed to load widget session' } },
            { status: 500, headers: noStoreHeaders() }
          )
        }
      },
    },
  },
})

function noStoreHeaders(): HeadersInit {
  return {
    'Cache-Control': 'no-store',
  }
}
