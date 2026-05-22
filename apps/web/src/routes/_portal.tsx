import { createFileRoute, redirect, Outlet } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { fetchUserAvatar } from '@/lib/server/functions/portal'
import { PortalHeader } from '@/components/public/portal-header'
import { AuthPopoverProvider } from '@/components/auth/auth-popover-context'
import { AuthDialog } from '@/components/auth/auth-dialog'
import { PortalAccessGate } from '@/components/portal/portal-access-gate'
import type { PortalAccessGateError } from '@/components/portal/portal-access-gate'
import { DEFAULT_PORTAL_CONFIG } from '@/lib/shared/types/settings'
import { generateThemeCSS, getGoogleFontsUrl } from '@/lib/shared/theme'
import { resolveLocale } from '@/lib/shared/i18n'
import { PortalIntlProvider } from '@/components/portal-intl-provider'
import { evaluatePortalAccess } from '@/lib/server/domains/settings/portal-access'

/** Resolve locale from Accept-Language header on the server. */
const getPortalLocale = createServerFn({ method: 'GET' }).handler(async () => {
  const { getRequestHeaders } = await import('@tanstack/react-start/server')
  const acceptLanguage = getRequestHeaders().get('accept-language')
  return resolveLocale(acceptLanguage)
})

export const Route = createFileRoute('/_portal')({
  beforeLoad: ({ context }) => {
    const { session, settings, userRole } = context

    // Portal-level visibility gate (Phase 1: team-only for private portals).
    // Throwing here — in beforeLoad — sets firstBadMatchIndex, which aborts
    // all child route loaders. No portal data is fetched or dehydrated for a
    // blocked visitor. (A throw from loader does not abort child loaders.)
    //
    // An anonymous Better Auth session has session.user but principalType===
    // 'anonymous' — mirror the check in widget.tsx to resolve auth state.
    const portalConfig = settings?.portalConfig
    const visibility = portalConfig?.access?.visibility ?? 'public'
    const isAnonymousPrincipal = session?.user?.principalType === 'anonymous'
    const isAuthenticated = !!session?.user && !isAnonymousPrincipal
    const role = (userRole ?? null) as 'admin' | 'member' | 'user' | null
    const accessResult = evaluatePortalAccess({
      visibility,
      role,
      isAuthenticated,
      userEmail: session?.user?.email ?? null,
      emailVerified: session?.user?.emailVerified ?? false,
      allowedDomains: portalConfig?.access?.allowedDomains ?? [],
    })

    if (!accessResult.granted) {
      // Both denied cases (unauthenticated + unauthorized) render an in-place
      // overlay via the route's errorComponent. The gate payload is carried
      // two ways so it survives SSR serialization — see parseGateError below.
      const org = settings?.settings
      const brandingData = settings?.brandingData ?? null
      const brandingConfig = settings?.brandingConfig ?? {}
      const hasThemeConfig = brandingConfig.light || brandingConfig.dark
      const gateError: PortalAccessGateError = {
        type: 'portal-access-gate',
        reason: accessResult.reason,
        workspaceName: org?.name ?? '',
        logoUrl: brandingData?.logoUrl ?? null,
        themeStyles: hasThemeConfig ? generateThemeCSS(brandingConfig) : '',
        customCss: settings?.customCss ?? '',
        authConfig: {
          found: true,
          oauth: settings?.publicPortalConfig?.oauth ?? DEFAULT_PORTAL_CONFIG.oauth,
          customProviderNames: settings?.publicPortalConfig?.customProviderNames,
        },
      }
      throw Object.assign(new Error(JSON.stringify(gateError)), gateError)
    }
  },
  loader: async ({ context }) => {
    const { session, settings, userRole, baseUrl } = context

    const org = settings?.settings
    if (!org) {
      throw redirect({ to: '/onboarding' })
    }

    // userRole comes from bootstrap data, avatar needs to be fetched
    const avatarData = session?.user
      ? await fetchUserAvatar({
          data: { userId: session.user.id, fallbackImageUrl: session.user.image },
        })
      : null

    const brandingData = settings?.brandingData ?? null
    const faviconData = settings?.faviconData ?? null
    const brandingConfig = settings?.brandingConfig ?? {}
    const customCss = settings?.customCss ?? ''
    const publicPortalConfig = settings?.publicPortalConfig ?? null

    const themeMode = brandingConfig.themeMode ?? 'user'

    // Always generate CSS from theme config (if structured vars exist)
    const hasThemeConfig = brandingConfig.light || brandingConfig.dark
    const themeStyles = hasThemeConfig ? generateThemeCSS(brandingConfig) : ''

    // Always apply custom CSS on top (cascades over theme styles)
    const customCssToApply = customCss

    // Always load Google Fonts from theme config
    const googleFontsUrl = getGoogleFontsUrl(brandingConfig)

    const initialUserData = session?.user
      ? {
          name: session.user.name,
          email: session.user.email,
          avatarUrl: avatarData?.avatarUrl ?? null,
        }
      : undefined

    const authConfig = {
      found: true,
      oauth: publicPortalConfig?.oauth ?? DEFAULT_PORTAL_CONFIG.oauth,
      customProviderNames: publicPortalConfig?.customProviderNames,
    }

    const locale = await getPortalLocale()

    return {
      org,
      baseUrl: baseUrl ?? '',
      userRole,
      session,
      brandingData,
      faviconData,
      themeStyles,
      customCss: customCssToApply,
      themeMode,
      googleFontsUrl,
      initialUserData,
      authConfig,
      locale,
    }
  },
  head: ({ loaderData }) => {
    // Favicon priority: dedicated favicon > workspace logo > default logo.png
    const faviconUrl =
      loaderData?.faviconData?.url || loaderData?.brandingData?.logoUrl || '/logo.png'

    const workspaceName = loaderData?.org?.name ?? 'Quackback'
    const description = `Share feedback, vote on feature requests, and track the ${workspaceName} roadmap.`
    const logoUrl = loaderData?.brandingData?.logoUrl || '/logo.png'

    const meta: Array<Record<string, string>> = [
      { title: workspaceName },
      { name: 'description', content: description },
      { property: 'og:site_name', content: workspaceName },
      { property: 'og:title', content: workspaceName },
      { property: 'og:description', content: description },
      { property: 'og:image', content: logoUrl },
      { name: 'twitter:title', content: workspaceName },
      { name: 'twitter:description', content: description },
    ]
    return {
      meta,
      links: [{ rel: 'icon', href: faviconUrl }],
    }
  },
  errorComponent: PortalErrorBoundary,
  component: PortalLayout,
})

/**
 * Catches errors thrown from the _portal loader. When the error is a
 * PortalAccessGateError we render the in-place overlay; anything else falls
 * through to the default error UI.
 *
 * The gate data is carried two ways so it survives SSR serialization:
 *   1. As extra properties on the Error object (works in pure client / dev).
 *   2. As JSON in the error message (survives when only message is preserved).
 */
function PortalErrorBoundary({ error }: { error: unknown; reset?: () => void }) {
  const gateErr = parseGateError(error)
  if (gateErr) {
    return (
      <PortalAccessGate
        reason={gateErr.reason}
        workspaceName={gateErr.workspaceName}
        logoUrl={gateErr.logoUrl}
        authConfig={gateErr.authConfig}
        themeStyles={gateErr.themeStyles}
        customCss={gateErr.customCss}
      />
    )
  }
  // Unknown error — surface a minimal message.
  const message = error instanceof Error ? error.message : 'An unexpected error occurred.'
  return (
    <div className="flex min-h-screen items-center justify-center p-8 text-center">
      <p className="text-muted-foreground">{message}</p>
    </div>
  )
}

function parseGateError(error: unknown): PortalAccessGateError | null {
  if (!(error instanceof Error)) return null
  // Fast path: extra properties survive (dev / client-only execution).
  const ext = error as unknown as Partial<PortalAccessGateError>
  if (ext.type === 'portal-access-gate') return ext as PortalAccessGateError
  // Fallback: parse from JSON message (SSR serialization strips extra props).
  try {
    const parsed = JSON.parse(error.message) as Partial<PortalAccessGateError>
    if (parsed.type === 'portal-access-gate') return parsed as PortalAccessGateError
  } catch {
    // not a gate error
  }
  return null
}

function PortalLayout() {
  const loaderData = Route.useLoaderData()
  const {
    org,
    userRole,
    brandingData,
    themeStyles,
    customCss,
    themeMode,
    googleFontsUrl,
    initialUserData,
    authConfig,
    locale,
  } = loaderData

  return (
    <PortalIntlProvider locale={locale}>
      <AuthPopoverProvider>
        <div className="min-h-screen bg-background flex flex-col">
          {googleFontsUrl && <link rel="stylesheet" href={googleFontsUrl} />}
          {themeStyles && <style dangerouslySetInnerHTML={{ __html: themeStyles }} />}
          {/* Custom CSS is injected after theme styles so it can override */}
          {customCss && <style dangerouslySetInnerHTML={{ __html: customCss }} />}
          <PortalHeader
            orgName={org.name}
            orgLogo={brandingData?.logoUrl ?? null}
            userRole={userRole}
            initialUserData={initialUserData}
            showThemeToggle={themeMode === 'user'}
          />
          <main className="flex-1 w-full flex flex-col">
            <Outlet />
          </main>
          <AuthDialog authConfig={authConfig} workspaceName={org.name} />
        </div>
      </AuthPopoverProvider>
    </PortalIntlProvider>
  )
}
