'use client'

import { useEffect, useRef } from 'react'
import { useRouteContext, useRouterState } from '@tanstack/react-router'
import type { FeatureFlags } from '@/lib/shared/types/settings'

/**
 * Fires an anonymous pageview beacon on portal route changes (visitor
 * analytics). The server independently drops beacons whenever visitor
 * analytics is disabled; the flag check here just avoids dead POSTs on
 * feature-off instances. Also honors the browser's opt-out signals,
 * restricts itself to portal routes, and dedupes re-renders of the same
 * URL. It sends no identifier — the server derives everything.
 */
export function VisitorBeacon() {
  const { settings } = useRouteContext({ from: '__root__' })
  const enabled = (settings?.featureFlags as FeatureFlags | undefined)?.visitorAnalytics ?? false
  const href = useRouterState({ select: (s) => s.location.href })
  // Public visitor-facing surfaces: the portal tree plus the standalone
  // changelog and help-center trees (the latter also serve the subdomain).
  const isPublicSurface = useRouterState({
    select: (s) =>
      s.matches.some((m) =>
        ['/_portal', '/changelog', '/hc', '/help'].some((prefix) => m.routeId.startsWith(prefix))
      ),
  })
  const lastTracked = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled || !isPublicSurface || lastTracked.current === href) return
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean }
    if (nav.doNotTrack === '1' || nav.globalPrivacyControl === true) return
    lastTracked.current = href

    const body = JSON.stringify({
      url: window.location.href,
      referrer: document.referrer,
      surface: 'portal',
    })
    if (!navigator.sendBeacon?.('/api/track', body)) {
      fetch('/api/track', { method: 'POST', body, keepalive: true }).catch(() => {})
    }
  }, [href, isPublicSurface, enabled])

  return null
}
