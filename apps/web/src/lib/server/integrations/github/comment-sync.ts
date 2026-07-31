/**
 * Two-way comment mirroring between Quackback and GitHub issue comments.
 *
 * Loop prevention rests on three layers, in order of what catches what:
 *
 *  1. **Identity check (inbound).** Comments Quackback writes arrive back on
 *     the `issue_comment` webhook authored by the connected OAuth account.
 *     The inbound handler drops those by login. See `inbound.ts`.
 *  2. **Link-table guard (outbound, here).** Any comment carrying an
 *     `inbound` row in `comment_external_links` came *from* GitHub, so it is
 *     never pushed back. This is the structural guarantee — layer 1 is only a
 *     fast path, and layer 2 still holds if the connected account is also a
 *     human who comments on the repo.
 *  3. **Unique (integration_type, external_id).** Webhook redelivery inserts
 *     nothing and creates no duplicate comment.
 *
 * Ordering matters: the inbound path writes its link row *before* dispatching
 * `comment.created`. Dispatching first would race this module's guard and
 * echo the comment straight back to GitHub.
 */

import { db, commentExternalLinks, postExternalLinks, integrations, eq, and } from '@/lib/server/db'
import type { CommentId, IntegrationId, PostId } from '@quackback/ids'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'github' })

const GITHUB_API = 'https://api.github.com'

export function githubHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'quackback',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/**
 * True when this comment was mirrored in from GitHub and must not be sent back.
 */
export async function isInboundComment(commentId: CommentId): Promise<boolean> {
  const existing = await db.query.commentExternalLinks.findFirst({
    where: and(
      eq(commentExternalLinks.commentId, commentId),
      eq(commentExternalLinks.direction, 'inbound')
    ),
    columns: { id: true },
  })
  return Boolean(existing)
}

/**
 * Resolve the GitHub issue number linked to a post, if any. A post with no
 * link simply isn't mirrored — this is what keeps comment sync scoped to
 * posts that actually have an issue, without needing a board filter.
 */
export async function findLinkedIssueNumber(postId: PostId): Promise<string | null> {
  const link = await db.query.postExternalLinks.findFirst({
    where: and(
      eq(postExternalLinks.postId, postId),
      eq(postExternalLinks.integrationType, 'github'),
      eq(postExternalLinks.status, 'active')
    ),
    columns: { externalId: true },
  })
  return link?.externalId ?? null
}

/**
 * Record the mapping between a Quackback comment and its GitHub counterpart.
 * Conflicts are ignored so redelivery and races stay harmless.
 *
 * When `integrationId` isn't supplied it's resolved by type — the hook worker's
 * config doesn't carry it, and holding the reference means links are cleaned up
 * by cascade when the integration is disconnected.
 */
export async function recordCommentLink(input: {
  commentId: CommentId
  integrationId?: IntegrationId | null
  externalId: string
  externalUrl?: string | null
  direction: 'inbound' | 'outbound'
}): Promise<void> {
  let integrationId = input.integrationId ?? null
  if (!integrationId) {
    const integration = await db.query.integrations.findFirst({
      where: eq(integrations.integrationType, 'github'),
      columns: { id: true },
    })
    integrationId = (integration?.id as IntegrationId | undefined) ?? null
  }

  await db
    .insert(commentExternalLinks)
    .values({
      commentId: input.commentId,
      integrationId,
      integrationType: 'github',
      externalId: input.externalId,
      externalUrl: input.externalUrl ?? null,
      direction: input.direction,
    })
    .onConflictDoNothing()
}

/**
 * Post a comment onto a GitHub issue. Returns the created comment's id and
 * URL, or throws with a `status` property for the caller to map.
 */
export async function postGitHubIssueComment(
  accessToken: string,
  ownerRepo: string,
  issueNumber: string,
  body: string
): Promise<{ id: string; htmlUrl: string }> {
  const response = await fetch(`${GITHUB_API}/repos/${ownerRepo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: githubHeaders(accessToken),
    body: JSON.stringify({ body }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw Object.assign(new Error(`HTTP ${response.status}: ${errorBody}`), {
      status: response.status,
    })
  }

  const created = (await response.json()) as { id: number; html_url: string }
  log.debug({ repo: ownerRepo, issue: issueNumber, comment_id: created.id }, 'comment posted')
  return { id: String(created.id), htmlUrl: created.html_url }
}
