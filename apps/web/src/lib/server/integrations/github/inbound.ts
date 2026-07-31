/**
 * GitHub inbound webhook handler.
 *
 * Receives `issues` and `issue_comment` events from GitHub and turns them into
 * status changes, new posts, or mirrored comments.
 * Signature: HMAC-SHA256 with `sha256=` prefix in `X-Hub-Signature-256` header.
 * Status: `action` field — `closed` or `reopened` on `issues` events.
 */

import { timingSafeEqual, createHmac } from 'crypto'
import type {
  InboundWebhookHandler,
  InboundWebhookResult,
  InboundCreatePostIntent,
  InboundCreateCommentIntent,
} from '../inbound-types'
import { QUACKBACK_MARKER } from './message'

/**
 * Whether a webhook payload was authored by the GitHub account this
 * integration is connected as — i.e. it is Quackback's own write echoing back.
 *
 * Note this means the connected account's genuine human comments are also
 * ignored; connect with a dedicated machine account rather than a personal one.
 * The link-table guard in the outbound hook is what makes loops structurally
 * impossible, so a miss here costs a skipped mirror, never a loop.
 */
function isOwnWrite(
  author: { login?: string } | undefined,
  config: Record<string, unknown>
): boolean {
  const connectedLogin = config.username as string | undefined
  if (!connectedLogin || !author?.login) return false
  return author.login.toLowerCase() === connectedLogin.toLowerCase()
}

/**
 * Label names on an issue payload. GitHub sends objects; bare strings are
 * tolerated defensively since the wizard's REST reads can see either shape.
 */
function issueLabelNames(issue: { labels?: Array<{ name?: string } | string> }): string[] {
  if (!Array.isArray(issue.labels)) return []
  return issue.labels
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
}

/**
 * Whether an issue passes the configured label allowlist.
 *
 * `config.importLabels` lets a workspace import only some issues — e.g. only
 * `enhancement`, so bug reports stay in the tracker where the fixing PR closes
 * them. An unset or empty list imports everything, which is the behaviour
 * every existing integration had before this filter existed.
 *
 * Matching is case-insensitive: GitHub preserves label case but people rename
 * `bug` to `Bug` often enough that an exact match would silently stop importing.
 */
function labelsAllowImport(
  issue: { labels?: Array<{ name?: string } | string> },
  config: Record<string, unknown>
): boolean {
  const configured = config.importLabels
  if (!Array.isArray(configured)) return true

  const allowed = new Set(
    configured
      .filter((label): label is string => typeof label === 'string' && label.trim().length > 0)
      .map((label) => label.trim().toLowerCase())
  )
  if (allowed.size === 0) return true

  return issueLabelNames(issue).some((name) => allowed.has(name.toLowerCase()))
}

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

    // Ignore closes and reopens Quackback itself performed. The import flow
    // closes the source issue right after creating the post, and that close
    // echoes straight back here — without this guard it would drive the
    // brand-new post to Closed. `sender` is who acted; `issue.user` is only
    // ever the original reporter, so it can't answer this question.
    if (isOwnWrite(payload.sender, config)) return null

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
    if (isOwnWrite(issue.user, config)) return null
    if (typeof issue.body === 'string' && issue.body.includes(QUACKBACK_MARKER)) {
      return null
    }

    // Policy filter, not an echo guard: only import the issue kinds this
    // workspace asked for. Unmatched issues are left alone in the tracker.
    if (!labelsAllowImport(issue, config)) return null

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

  async parseCreateComment(
    body: string,
    config: Record<string, unknown> = {}
  ): Promise<InboundCreateCommentIntent | null> {
    const payload = JSON.parse(body)

    // Only newly created comments mirror. Edits and deletes are deliberately
    // out of scope — a stale mirrored comment is cheaper than the
    // reconciliation machinery two-way edit sync would need.
    if (payload.action !== 'created') return null

    const comment = payload.comment
    const issue = payload.issue
    if (!comment?.id || !issue?.number) return null

    // Comments on pull requests arrive on this same event; PRs aren't mirrored.
    if (issue.pull_request) return null

    if (!repoMatches(payload, config)) return null

    // Ignore comments Quackback itself posted, by author and by marker.
    if (isOwnWrite(comment.user, config)) return null
    if (typeof comment.body === 'string' && comment.body.includes(QUACKBACK_MARKER)) {
      return null
    }

    const user = comment.user
    return {
      externalId: String(comment.id),
      externalParentId: String(issue.number),
      body: comment.body || '',
      externalUrl: comment.html_url,
      reporter: user?.login
        ? { githubId: user.id ?? null, login: user.login, name: user.name ?? null }
        : undefined,
      eventType: 'issue_comment.created',
    }
  },
}
