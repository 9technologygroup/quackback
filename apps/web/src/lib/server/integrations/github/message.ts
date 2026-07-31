/**
 * GitHub issue formatting utilities.
 */

import type { EventData } from '../../events/types'
import { stripHtml, truncate } from '../../events/hook-utils'
import { buildPostUrl, getAuthorName } from '../message-utils'

/**
 * Marker embedded in every issue and comment body Quackback writes to GitHub.
 * The inbound handler uses it to recognise its own writes echoing back.
 */
export const QUACKBACK_MARKER = '[View in Quackback]('

/**
 * Build a GitHub issue title and body from a post.created event.
 */
export function buildGitHubIssueBody(
  event: EventData,
  rootUrl: string
): { title: string; body: string } {
  if (event.type !== 'post.created') {
    return { title: 'Feedback', body: '' }
  }

  const { post } = event.data
  const postUrl = buildPostUrl(rootUrl, post.boardSlug, post.id)
  const content = truncate(stripHtml(post.content), 2000)
  const author = getAuthorName(post)

  const body = [
    content,
    '',
    '---',
    '',
    `**Submitted by:** ${author}`,
    `**Board:** ${post.boardSlug}`,
    '',
    `[View in Quackback](${postUrl})`,
  ].join('\n')

  return { title: post.title, body }
}

/**
 * Build the issue body for a post being promoted to scheduled work.
 *
 * Deliberately different from the post.created body: this issue is a work item
 * someone is about to pick up, not an echo of a suggestion. Vote count leads
 * because "how many people asked for this" is the context a developer wants and
 * the reason it was scheduled at all, whereas who first suggested it is a
 * detail they can follow the link for.
 */
export function buildPromotedIssueBody(input: {
  title: string
  content: string
  voteCount: number
  boardSlug: string
  postId: string
  status: string
  rootUrl: string
}): { title: string; body: string } {
  const postUrl = buildPostUrl(input.rootUrl, input.boardSlug, input.postId)
  const votes = input.voteCount === 1 ? '1 vote' : `${input.voteCount} votes`

  const body = [
    truncate(stripHtml(input.content), 2000),
    '',
    '---',
    '',
    `**${votes}** · moved to **${input.status}** in Quackback`,
    '',
    'Discussion on this issue is mirrored back to the feedback post, so the',
    'people who requested it can follow along without a GitHub account.',
    '',
    `[View in Quackback](${postUrl})`,
  ].join('\n')

  return { title: input.title, body }
}

/**
 * Build a GitHub issue-comment body from a comment.created event.
 *
 * Quackback can't post as the commenter (there's no token for them), so the
 * author is named in the body instead. The trailing Quackback link doubles as
 * the {@link QUACKBACK_MARKER} the inbound handler filters on.
 */
export function buildGitHubCommentBody(event: EventData, rootUrl: string): string {
  if (event.type !== 'comment.created') return ''

  const { comment, post } = event.data
  const postUrl = buildPostUrl(rootUrl, post.boardSlug, post.id)
  const content = truncate(stripHtml(comment.content), 2000)
  const author = getAuthorName(comment)

  return [
    `**${author}** commented in Quackback:`,
    '',
    content,
    '',
    '---',
    '',
    `[View in Quackback](${postUrl})`,
  ].join('\n')
}
