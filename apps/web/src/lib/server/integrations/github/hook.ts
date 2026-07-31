/**
 * GitHub hook handler.
 *
 * Creates GitHub issues from new feedback, and mirrors Quackback comments onto
 * the linked issue. Board scoping for both lives on the event mapping's
 * `filters.boardIds` (set in the GitHub config screen); comment mirroring is
 * additionally self-limiting because it no-ops on posts with no linked issue.
 */

import type { HookHandler, HookResult } from '../../events/hook-types'
import type { EventData } from '../../events/types'
import { isRetryableError } from '../../events/hook-utils'
import { buildGitHubIssueBody, buildGitHubCommentBody, buildPromotedIssueBody } from './message'
import { createGitHubIssue } from './issue-writes'
import {
  githubHeaders,
  isInboundComment,
  findLinkedIssueNumber,
  recordCommentLink,
  postGitHubIssueComment,
} from './comment-sync'
import type { CommentId, PostId } from '@quackback/ids'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'github' })

const GITHUB_API = 'https://api.github.com'

export interface GitHubTarget {
  channelId: string // "owner/repo" stored as channelId for consistency
}

export interface GitHubConfig {
  accessToken: string
  rootUrl: string
  /**
   * Status name that promotes a post to a GitHub work item. When unset, no
   * status change creates an issue — the promotion flow is opt-in, because a
   * workspace that already creates an issue on `post.created` would otherwise
   * get a second one the first time anything is scheduled.
   */
  promoteOnStatus?: string
  /** Labels applied to a promoted work item, e.g. ['enhancement']. */
  promoteLabels?: string[]
}

/**
 * Map a GitHub API failure onto a HookResult. Auth/permission/validation
 * problems are terminal; rate limits are worth retrying.
 */
function mapGitHubError(status: number, errorBody: string, ownerRepo: string): HookResult {
  if (status === 401) {
    return {
      success: false,
      error: 'Authentication failed. Please reconnect GitHub.',
      shouldRetry: false,
    }
  }
  if (status === 404) {
    return {
      success: false,
      error: `Repository "${ownerRepo}" not found or not accessible.`,
      shouldRetry: false,
    }
  }
  if (status === 422) {
    return { success: false, error: `Validation error: ${errorBody}`, shouldRetry: false }
  }
  if (status === 429) {
    return { success: false, error: 'Rate limited by GitHub API.', shouldRetry: true }
  }
  return { success: false, error: `HTTP ${status}: ${errorBody}`, shouldRetry: status >= 500 }
}

/**
 * Mirror a Quackback comment onto its post's linked GitHub issue.
 *
 * Deliberately returns no `externalId`: the generic worker persists any
 * returned id as a *post* external link (see events/process.ts), and
 * comment.created events carry a post reference — returning one here would
 * corrupt the issue-number lookup that status sync depends on. The comment's
 * own mapping is written to `comment_external_links` instead.
 */
async function syncCommentToGitHub(
  event: Extract<EventData, { type: 'comment.created' }>,
  ownerRepo: string,
  config: GitHubConfig
): Promise<HookResult> {
  const { comment, post } = event.data

  // Private comments never leave Quackback. getIntegrationTargets already
  // filters these out; repeated here so the guarantee survives a direct call.
  if (comment.isPrivate) return { success: true }

  // Echo guard — this comment arrived from GitHub in the first place.
  if (await isInboundComment(comment.id as CommentId)) {
    log.debug({ comment_id: comment.id }, 'comment originated on github, not mirroring back')
    return { success: true }
  }

  const issueNumber = await findLinkedIssueNumber(post.id as PostId)
  if (!issueNumber) {
    // Post has no GitHub issue — nothing to comment on.
    return { success: true }
  }

  const body = buildGitHubCommentBody(event, config.rootUrl)

  try {
    const created = await postGitHubIssueComment(config.accessToken, ownerRepo, issueNumber, body)

    await recordCommentLink({
      commentId: comment.id as CommentId,
      externalId: created.id,
      externalUrl: created.htmlUrl,
      direction: 'outbound',
    })

    log.info(
      { comment_id: comment.id, issue_number: issueNumber, repo: ownerRepo },
      'comment mirrored to github'
    )
    return { success: true }
  } catch (error) {
    const status = (error as { status?: number }).status
    if (typeof status === 'number') {
      const errorMsg = error instanceof Error ? error.message : ''
      return mapGitHubError(status, errorMsg, ownerRepo)
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      shouldRetry: isRetryableError(error),
    }
  }
}

/**
 * Create a GitHub work item for a post that has just reached the configured
 * promotion status.
 *
 * This is what lets the tracker hold only scheduled work: an idea gathers votes
 * in Quackback, and only when it is actually committed to does it become an
 * issue a developer can pick up and a PR can close.
 *
 * No-ops when the post already has a linked issue. Re-entering the promotion
 * status — a post moved back to Planned after slipping a sprint, or a status
 * corrected by hand — must not mint a second issue for the same work.
 */
async function promotePostToIssue(
  event: Extract<EventData, { type: 'post.status_changed' }>,
  ownerRepo: string,
  config: GitHubConfig
): Promise<HookResult> {
  const { post, newStatus } = event.data

  const promoteOn = config.promoteOnStatus?.trim()
  if (!promoteOn || newStatus.toLowerCase() !== promoteOn.toLowerCase()) {
    return { success: true }
  }

  const existing = await findLinkedIssueNumber(post.id as PostId)
  if (existing) {
    log.debug(
      { post_id: post.id, issue_number: existing },
      'post already linked to an issue, not promoting again'
    )
    return { success: true }
  }

  // status_changed carries only a post reference, so the body content and vote
  // count — the two things that make the issue worth reading — are read here.
  const { getPostForPromotion } = await import('@/lib/server/domains/posts/post.query')
  const detail = await getPostForPromotion(post.id as PostId)
  if (!detail) {
    log.warn({ post_id: post.id }, 'post vanished before promotion, skipping')
    return { success: true }
  }

  const { title, body } = buildPromotedIssueBody({
    title: post.title,
    content: detail.content,
    voteCount: detail.voteCount,
    boardSlug: post.boardSlug,
    postId: post.id,
    status: newStatus,
    rootUrl: config.rootUrl,
  })

  try {
    const issue = await createGitHubIssue(config.accessToken, ownerRepo, {
      title,
      body,
      labels: config.promoteLabels,
    })
    log.info(
      { post_id: post.id, issue_number: issue.number, repo: ownerRepo, status: newStatus },
      'post promoted to github issue'
    )
    return { success: true, externalId: String(issue.number), externalUrl: issue.htmlUrl }
  } catch (error) {
    const status = (error as { status?: number }).status
    if (typeof status === 'number') {
      return mapGitHubError(status, error instanceof Error ? error.message : '', ownerRepo)
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      shouldRetry: isRetryableError(error),
    }
  }
}

export const githubHook: HookHandler = {
  async run(event: EventData, target: unknown, config: unknown): Promise<HookResult> {
    const { channelId: ownerRepo } = target as GitHubTarget
    const githubConfig = config as GitHubConfig

    if (event.type === 'comment.created') {
      return syncCommentToGitHub(event, ownerRepo, githubConfig)
    }

    if (event.type === 'post.status_changed') {
      return promotePostToIssue(event, ownerRepo, githubConfig)
    }

    // Only create issues for new feedback
    if (event.type !== 'post.created') {
      return { success: true }
    }

    log.debug({ event_type: event.type, repo: ownerRepo }, 'creating issue')

    const { title, body } = buildGitHubIssueBody(event, githubConfig.rootUrl)

    try {
      const response = await fetch(`${GITHUB_API}/repos/${ownerRepo}/issues`, {
        method: 'POST',
        headers: githubHeaders(githubConfig.accessToken),
        body: JSON.stringify({ title, body }),
      })

      if (!response.ok) {
        const status = response.status
        const errorBody = await response.text()

        if (status >= 500) {
          throw Object.assign(new Error(`HTTP ${status}: ${errorBody}`), { status })
        }

        return mapGitHubError(status, errorBody, ownerRepo)
      }

      const issue = (await response.json()) as {
        number: number
        html_url: string
      }

      log.info({ issue_number: issue.number, repo: ownerRepo }, 'issue created')
      return {
        success: true,
        externalId: String(issue.number),
        externalUrl: issue.html_url,
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'

      return {
        success: false,
        error: errorMsg,
        shouldRetry: isRetryableError(error),
      }
    }
  },
}
