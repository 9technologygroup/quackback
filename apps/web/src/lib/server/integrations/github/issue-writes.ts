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
 * Create an issue. Returns the new issue's number and URL.
 */
export async function createGitHubIssue(
  accessToken: string,
  ownerRepo: string,
  input: { title: string; body: string; labels?: string[] }
): Promise<{ number: number; htmlUrl: string }> {
  const response = await fetch(`${GITHUB_API}/repos/${ownerRepo}/issues`, {
    method: 'POST',
    headers: githubHeaders(accessToken),
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
 * Close an issue, optionally recording why.
 *
 * `not_planned` is the right reason for an issue whose tracking moved to
 * Quackback: it renders as a grey icon rather than the purple "completed" tick,
 * so the issue reads as "handled elsewhere" instead of "shipped".
 */
export async function closeGitHubIssue(
  accessToken: string,
  ownerRepo: string,
  issueNumber: string | number,
  stateReason: 'completed' | 'not_planned' = 'not_planned'
): Promise<void> {
  const response = await fetch(`${GITHUB_API}/repos/${ownerRepo}/issues/${issueNumber}`, {
    method: 'PATCH',
    headers: githubHeaders(accessToken),
    body: JSON.stringify({ state: 'closed', state_reason: stateReason }),
  })

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

  const response = await fetch(`${GITHUB_API}/repos/${ownerRepo}/issues/${issueNumber}/labels`, {
    method: 'POST',
    headers: githubHeaders(accessToken),
    body: JSON.stringify({ labels }),
  })

  if (!response.ok) {
    throw httpError(response.status, await response.text())
  }
}
