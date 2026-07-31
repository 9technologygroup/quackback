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
