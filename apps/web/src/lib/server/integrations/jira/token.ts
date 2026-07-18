/**
 * Jira OAuth token access with refresh: tokens expire ~hourly, so every API
 * caller must go through here rather than reading the stored accessToken raw.
 * Refreshes (and persists) when expired or within the 5-minute buffer.
 */
import { decryptSecrets, encryptSecrets } from '../encryption'
import { db, integrations, eq } from '@/lib/server/db'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'jira' })

interface JiraTokenConfig {
  tokenExpiresAt?: string
}

/** Refresh Jira token if expired or about to expire (within 5 minutes). Returns current access token. */
export async function getJiraAccessToken(integration: {
  secrets: unknown
  config: unknown
}): Promise<string> {
  const secrets = decryptSecrets<{ accessToken: string; refreshToken?: string }>(
    integration.secrets as string
  )
  const cfg = (integration.config ?? {}) as JiraTokenConfig

  if (secrets.refreshToken && cfg.tokenExpiresAt) {
    const expiresAt = new Date(cfg.tokenExpiresAt).getTime()
    const bufferMs = 5 * 60 * 1000
    if (Date.now() >= expiresAt - bufferMs) {
      log.info('access token expired, refreshing')
      const { refreshJiraToken } = await import('./oauth')
      const { getPlatformCredentials } =
        await import('@/lib/server/domains/platform-credentials/platform-credential.service')
      const credentials = await getPlatformCredentials('jira')
      const refreshed = await refreshJiraToken(secrets.refreshToken, credentials ?? undefined)

      const newExpiry = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
      await db
        .update(integrations)
        .set({
          secrets: encryptSecrets({
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
          }),
          config: { ...cfg, tokenExpiresAt: newExpiry },
          updatedAt: new Date(),
        })
        .where(eq(integrations.integrationType, 'jira'))

      return refreshed.accessToken
    }
  }

  return secrets.accessToken
}
