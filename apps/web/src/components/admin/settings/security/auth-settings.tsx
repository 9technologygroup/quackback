import { useNavigate } from '@tanstack/react-router'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AdminAuthSettings } from './admin-auth-settings'
import { PortalAuthTab } from './portal-auth-tab'
import type { AuthConfig, PortalAuthMethods } from '@/lib/shared/types/settings'
import type { SsoStatus } from '@/lib/server/functions/sso'

export type AuthTab = 'team' | 'portal'

interface AuthSettingsProps {
  /** Current selected tab. URL-driven via `?tab=` so the choice is
   *  bookmarkable and the back button switches back. */
  tab: AuthTab
  /** Team-side auth config from settings.authConfig. */
  teamAuthConfig: AuthConfig
  /** Portal-side oauth/methods from settings.portalConfig.oauth. */
  portalOauth: PortalAuthMethods
  credentialStatus: Record<string, boolean> & { _emailConfigured?: boolean }
  customOidcProviderTier: boolean
  ssoStatus: SsoStatus
}

/**
 * Unified Authentication settings page.
 *
 * Two audience-scoped tabs (Team and Portal) sit on top of the same
 * provider catalog and `platform_credentials` rows. Selecting a tab
 * shows the per-audience methods + per-audience OAuth toggles; the
 * Team tab also surfaces SSO/OIDC configuration and enforcement.
 *
 * Provider credentials are written by a shared `<AuthProviderCredentialsDialog>`
 * opened from either tab — the visible reuse is what teaches admins
 * the "set once, enable per audience" model.
 *
 * The selected tab is stored in `?tab=`. Sidebar entries from both
 * "Security" and "End Users" point at the same route with different
 * default tabs, so muscle memory from either nav location lands the
 * admin on the right view.
 */
export function AuthSettings({
  tab,
  teamAuthConfig,
  portalOauth,
  credentialStatus,
  customOidcProviderTier,
  ssoStatus,
}: AuthSettingsProps) {
  // No `from` — passes an absolute `to`, so binding the navigate hook
  // to a route would just append paths under TanStack Router's
  // relative-resolution rules. Same goes for useSearch.
  const navigate = useNavigate()

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        // URL-driven tab state. `replace: true` so the back button
        // doesn't accumulate per-click history entries within the page.
        const nextTab = next as AuthTab
        void navigate({
          to: '/admin/settings/security/authentication',
          search: { tab: nextTab },
          replace: true,
        })
      }}
      className="space-y-6"
    >
      <TabsList className="border-b border-border/50">
        <TabsTrigger value="team">Team</TabsTrigger>
        <TabsTrigger value="portal">Portal</TabsTrigger>
      </TabsList>

      <TabsContent value="team">
        <AdminAuthSettings
          initialConfig={teamAuthConfig}
          customOidcProviderTier={customOidcProviderTier}
          ssoStatus={ssoStatus}
        />
      </TabsContent>

      <TabsContent value="portal">
        <PortalAuthTab initialOauth={portalOauth} credentialStatus={credentialStatus} />
      </TabsContent>
    </Tabs>
  )
}
