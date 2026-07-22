/**
 * GitHub inbound webhook handler.
 *
 * Receives webhook events from GitHub and extracts issue status changes.
 * Signature: HMAC-SHA256 with `sha256=` prefix in `X-Hub-Signature-256` header.
 * Status: `action` field — `closed` or `reopened` on `issues` events.
 */

import { timingSafeEqual, createHmac } from 'crypto'
import type {
  InboundWebhookHandler,
  InboundWebhookResult,
  InboundCreatePostIntent,
} from '../inbound-types'

/**
 * Marker embedded in issue bodies created by our own outbound hook
 * (buildGitHubIssueBody). Used to ignore the `issues.opened` webhook that
 * GitHub delivers for issues Quackback itself created — otherwise an outbound
 * issue would echo back as a duplicate inbound post.
 */
const QUACKBACK_ISSUE_MARKER = '[View in Quackback]('

/**
 * Whether the webhook's repository matches the integration's configured repo
 * (`config.channelId` is "owner/repo"). Prevents a stale/other repo that shares
 * the webhook secret from creating posts, and stops cross-repo issue-number
 * collisions. Allows through only when we genuinely can't determine the repo.
 */
function repoMatches(
  payload: { repository?: { full_name?: string } },
  config: Record<string, unknown>
): boolean {
  const expected = config.channelId as string | undefined
  if (!expected) return true
  const actual = payload.repository?.full_name
  if (!actual) return true
  return actual === expected
}

export const githubInboundHandler: InboundWebhookHandler = {
  async verifySignature(request: Request, body: string, secret: string): Promise<true | Response> {
    const signature = request.headers.get('X-Hub-Signature-256')
    if (!signature) {
      return new Response('Missing signature', { status: 401 })
    }

    const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
    const valid =
      signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected))

    if (!valid) {
      return new Response('Invalid signature', { status: 401 })
    }

    return true
  },

  async parseStatusChange(
    body: string,
    config: Record<string, unknown> = {}
  ): Promise<InboundWebhookResult | null> {
    const payload = JSON.parse(body)

    // Only handle issue events with relevant actions
    if (payload.action !== 'closed' && payload.action !== 'reopened') {
      return null
    }

    if (!payload.issue?.number) return null
    if (!repoMatches(payload, config)) return null

    // Map GitHub actions to status names
    const externalStatus = payload.action === 'closed' ? 'Closed' : 'Open'

    return {
      externalId: String(payload.issue.number),
      externalStatus,
      eventType: `issues.${payload.action}`,
    }
  },

  async parseCreatePost(
    body: string,
    config: Record<string, unknown> = {}
  ): Promise<InboundCreatePostIntent | null> {
    const payload = JSON.parse(body)

    // Only newly opened issues create posts.
    if (payload.action !== 'opened') return null

    const issue = payload.issue
    if (!issue?.number) return null

    // The `issues` webhook only delivers issues (PRs come on `pull_request`),
    // but guard defensively in case GitHub ever includes a pull_request ref.
    if (issue.pull_request) return null

    // Reject issues from a different repo than the one configured.
    if (!repoMatches(payload, config)) return null

    // Ignore issues Quackback itself created via the outbound hook — otherwise
    // an outbound issue echoes back as a duplicate inbound post.
    if (typeof issue.body === 'string' && issue.body.includes(QUACKBACK_ISSUE_MARKER)) {
      return null
    }

    const user = issue.user
    return {
      externalId: String(issue.number),
      title: issue.title || `Issue #${issue.number}`,
      body: issue.body || '',
      externalUrl: issue.html_url,
      // Only attribute a reporter when we have a usable login — otherwise the
      // synthetic email would collapse to a shared `undefined@…` bucket.
      reporter: user?.login
        ? { githubId: user.id ?? null, login: user.login, name: user.name ?? null }
        : undefined,
      eventType: `issues.${payload.action}`,
    }
  },
}
