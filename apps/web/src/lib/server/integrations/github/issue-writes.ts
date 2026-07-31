/**
 * GitHub issue write operations (create, close, label).
 *
 * Kept apart from `issues.ts`, which only reads for the import wizard, and from
 * `comment-sync.ts`, which owns comment bodies and their link table. Both the
 * outbound hook and the inbound import path write issues, so the calls live
 * here rather than being inlined in one of them.
 */

import { githubHeaders } from './comment-sync'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'github' })

const GITHUB_API = 'https://api.github.com'

/** An error carrying the HTTP status so callers can map it to a HookResult. */
function httpError(status: number, body: string): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}: ${body}`), { status })
}

/**
 * Perform a mutating GitHub request, waiting out rate limits.
 *
 * Writes are governed by GitHub's *secondary* limits as well as the hourly one,
 * and those trigger on bursts of content creation — exactly what a bulk import
 * of several hundred issues looks like. A rejected write here is not a lost
 * request but a wrong outcome: an issue commented on but never closed. So a
 * limit is waited out rather than failed, and only genuine errors propagate.
 *
 * Rate-limit waits don't consume the retry budget, since they aren't failures.
 */
async function ghWrite(url: string, accessToken: string, init: RequestInit): Promise<Response> {
  const maxAttempts = 4
  let attempt = 0

  while (true) {
    let response: Response
    try {
      response = await fetch(url, { ...init, headers: githubHeaders(accessToken) })
    } catch (err) {
      if (++attempt >= maxAttempts) throw err instanceof Error ? err : new Error(String(err))
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      continue
    }

    const retryAfter = response.headers.get('Retry-After')
    const remaining = response.headers.get('X-RateLimit-Remaining')
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 && (remaining === '0' || retryAfter != null))

    if (rateLimited) {
      let waitMs: number
      if (retryAfter != null) {
        waitMs = Number(retryAfter) * 1000
      } else {
        const reset = Number(response.headers.get('X-RateLimit-Reset') ?? '0') * 1000
        waitMs = Math.max(0, reset - Date.now()) + 1000
      }
      log.warn({ url, wait_ms: Math.min(waitMs, 60_000) }, 'github rate limited, waiting')
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 60_000)))
      continue
    }

    if (response.status >= 500 && ++attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      continue
    }

    return response
  }
}

/**
 * Create an issue. Returns the new issue's number and URL.
 */
export async function createGitHubIssue(
  accessToken: string,
  ownerRepo: string,
  input: { title: string; body: string; labels?: string[] }
): Promise<{ number: number; htmlUrl: string }> {
  const response = await ghWrite(`${GITHUB_API}/repos/${ownerRepo}/issues`, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      ...(input.labels?.length ? { labels: input.labels } : {}),
    }),
  })

  if (!response.ok) {
    throw httpError(response.status, await response.text())
  }

  const issue = (await response.json()) as { number: number; html_url: string }
  log.info({ repo: ownerRepo, issue_number: issue.number }, 'issue created')
  return { number: issue.number, htmlUrl: issue.html_url }
}

/**
 * Close an issue, recording why.
 *
 * `duplicate` is the right reason for an issue whose tracking moved elsewhere.
 * GitHub offers no "migrated" — the enum is completed / not_planned / duplicate
 * / reopened — and of those, duplicate is the only one that means "the
 * canonical record for this is somewhere else", which is exactly what a
 * migration is. `not_planned` reads as a rejection to the person who filed it,
 * and `completed` claims something shipped when nothing has been built.
 */
export async function closeGitHubIssue(
  accessToken: string,
  ownerRepo: string,
  issueNumber: string | number,
  stateReason: 'completed' | 'not_planned' | 'duplicate' = 'duplicate'
): Promise<void> {
  const response = await ghWrite(
    `${GITHUB_API}/repos/${ownerRepo}/issues/${issueNumber}`,
    accessToken,
    {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed', state_reason: stateReason }),
    }
  )

  if (!response.ok) {
    throw httpError(response.status, await response.text())
  }

  log.info(
    { repo: ownerRepo, issue_number: issueNumber, state_reason: stateReason },
    'issue closed'
  )
}

/**
 * Add labels to an issue. Additive — GitHub's POST endpoint leaves existing
 * labels alone, so this never clobbers a maintainer's triage.
 */
export async function addGitHubIssueLabels(
  accessToken: string,
  ownerRepo: string,
  issueNumber: string | number,
  labels: string[]
): Promise<void> {
  if (labels.length === 0) return

  const response = await ghWrite(
    `${GITHUB_API}/repos/${ownerRepo}/issues/${issueNumber}/labels`,
    accessToken,
    { method: 'POST', body: JSON.stringify({ labels }) }
  )

  if (!response.ok) {
    throw httpError(response.status, await response.text())
  }
}
