/**
 * GitHub webhook registration.
 *
 * Uses GitHub REST API to create/delete webhooks for issue status sync and
 * comment mirroring.
 */

import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'github' })

const GITHUB_API = 'https://api.github.com'

/**
 * Events Quackback subscribes to.
 *
 * `issues` drives status sync and inbound post creation; `issue_comment`
 * drives comment mirroring. Hooks registered before comment mirroring shipped
 * only carry `issues` — {@link registerGitHubWebhook} repairs those in place
 * when it finds one already pointing at our callback URL.
 */
const GITHUB_WEBHOOK_EVENTS = ['issues', 'issue_comment']

interface GitHubWebhookResult {
  webhookId: string
}

function headers(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'quackback',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/**
 * Find an existing hook on the repo pointing at our callback URL. GitHub
 * rejects a duplicate hook with 422 rather than returning the existing one,
 * so we look it up to adopt it.
 */
async function findExistingHook(
  accessToken: string,
  ownerRepo: string,
  callbackUrl: string
): Promise<string | null> {
  const response = await fetch(`${GITHUB_API}/repos/${ownerRepo}/hooks?per_page=100`, {
    headers: headers(accessToken),
  })
  if (!response.ok) return null

  const hooks = (await response.json()) as Array<{
    id: number
    config?: { url?: string }
  }>
  const match = hooks.find((h) => h.config?.url === callbackUrl)
  return match ? String(match.id) : null
}

/**
 * Point an existing hook at the current event list and secret. Used to bring
 * hooks created by older versions up to date without the admin having to
 * delete and recreate the integration.
 */
async function updateHook(
  accessToken: string,
  ownerRepo: string,
  webhookId: string,
  callbackUrl: string,
  secret: string
): Promise<void> {
  const response = await fetch(`${GITHUB_API}/repos/${ownerRepo}/hooks/${webhookId}`, {
    method: 'PATCH',
    headers: headers(accessToken),
    body: JSON.stringify({
      active: true,
      events: GITHUB_WEBHOOK_EVENTS,
      config: {
        url: callbackUrl,
        content_type: 'json',
        secret,
        insecure_ssl: '0',
      },
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub API error ${response.status}: ${body}`)
  }
}

/**
 * Register a webhook with GitHub to receive issue and comment events.
 *
 * Idempotent: if a hook for this callback URL already exists, it is updated in
 * place (events + secret) and its id returned, rather than failing on GitHub's
 * duplicate-hook 422.
 */
export async function registerGitHubWebhook(
  accessToken: string,
  ownerRepo: string,
  callbackUrl: string,
  secret: string
): Promise<GitHubWebhookResult> {
  const response = await fetch(`${GITHUB_API}/repos/${ownerRepo}/hooks`, {
    method: 'POST',
    headers: headers(accessToken),
    body: JSON.stringify({
      name: 'web',
      active: true,
      events: GITHUB_WEBHOOK_EVENTS,
      config: {
        url: callbackUrl,
        content_type: 'json',
        secret,
        insecure_ssl: '0',
      },
    }),
  })

  if (response.ok) {
    const hook = (await response.json()) as { id: number }
    return { webhookId: String(hook.id) }
  }

  const body = await response.text()

  // 422 is GitHub's "hook already exists on this repository". Adopt and repair
  // it so re-running setup upgrades a hook that predates comment mirroring.
  if (response.status === 422) {
    const existingId = await findExistingHook(accessToken, ownerRepo, callbackUrl)
    if (existingId) {
      await updateHook(accessToken, ownerRepo, existingId, callbackUrl, secret)
      log.info(
        { repo: ownerRepo, webhook_id: existingId },
        'adopted existing webhook and updated its event list'
      )
      return { webhookId: existingId }
    }
  }

  throw new Error(`GitHub API error ${response.status}: ${body}`)
}

/**
 * Delete a webhook from GitHub.
 */
export async function deleteGitHubWebhook(
  accessToken: string,
  ownerRepo: string,
  webhookId: string
): Promise<void> {
  await fetch(`${GITHUB_API}/repos/${ownerRepo}/hooks/${webhookId}`, {
    method: 'DELETE',
    headers: headers(accessToken),
  })
}
