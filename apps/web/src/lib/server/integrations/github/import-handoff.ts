/**
 * Hand an imported GitHub issue over to Quackback.
 *
 * When a workspace routes feature requests to its feedback portal, the issue
 * that raised one has done its job the moment the post exists. This comments
 * with a link, labels the issue, and closes it, so the reporter is told where
 * the conversation moved rather than being left watching a thread nobody reads.
 *
 * Opt-in via `config.handoffImported`. Left off, an import is purely additive
 * and touches nothing on GitHub — the right default, since closing other
 * people's issues is not a side effect anyone should get by surprise.
 *
 * Every failure here is logged and swallowed. The post and its link already
 * exist by this point, so a GitHub write that fails costs a tidy-up, not data.
 */

import { config as appConfig } from '@/lib/server/config'
import { buildPostUrl } from '../message-utils'
import { postGitHubIssueComment } from './comment-sync'
import { closeGitHubIssue, addGitHubIssueLabels } from './issue-writes'
import type { PostId } from '@quackback/ids'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'github' })

const DEFAULT_MESSAGE =
  'Thanks for raising this! Feature requests are tracked on our feedback portal, ' +
  'where they can be voted on and prioritised.\n\n' +
  'This has been imported to {{url}} — please follow it there for updates.\n\n' +
  'Closing this issue, as the request is now tracked in Quackback.'

export interface ImportHandoffInput {
  config: Record<string, unknown>
  secrets: Record<string, unknown>
  issueNumber: string
  postId: PostId
  boardSlug: string
}

/**
 * Resolve the access token. Inbound webhooks decrypt secrets separately from
 * config, but the hook worker folds them together — accept either shape so the
 * caller doesn't have to know which path it came from.
 */
function resolveAccessToken(input: ImportHandoffInput): string | null {
  const fromSecrets = input.secrets.accessToken
  if (typeof fromSecrets === 'string' && fromSecrets) return fromSecrets
  const fromConfig = input.config.accessToken
  if (typeof fromConfig === 'string' && fromConfig) return fromConfig
  return null
}

export async function handoffImportedGitHubIssue(input: ImportHandoffInput): Promise<void> {
  if (input.config.handoffImported !== true) return

  const ownerRepo = input.config.channelId as string | undefined
  if (!ownerRepo) {
    log.warn('handoff enabled but no repository configured, skipping')
    return
  }

  const accessToken = resolveAccessToken(input)
  if (!accessToken) {
    log.warn({ issue_number: input.issueNumber }, 'handoff enabled but no access token, skipping')
    return
  }

  const postUrl = buildPostUrl(appConfig.baseUrl, input.boardSlug, input.postId)
  const template =
    typeof input.config.handoffMessage === 'string' && input.config.handoffMessage.trim()
      ? input.config.handoffMessage
      : DEFAULT_MESSAGE
  // The trailing link doubles as the marker the inbound handler filters on, so
  // it is appended even when a custom message forgets to include the URL.
  const message = template.includes('{{url}}')
    ? template.replaceAll('{{url}}', postUrl)
    : `${template}\n\n[View in Quackback](${postUrl})`

  try {
    await postGitHubIssueComment(accessToken, ownerRepo, input.issueNumber, message)
  } catch (error) {
    log.error({ err: error, issue_number: input.issueNumber }, 'handoff comment failed')
  }

  const labels = Array.isArray(input.config.handoffLabels)
    ? input.config.handoffLabels.filter((l): l is string => typeof l === 'string' && l.length > 0)
    : []
  if (labels.length > 0) {
    try {
      await addGitHubIssueLabels(accessToken, ownerRepo, input.issueNumber, labels)
    } catch (error) {
      log.error({ err: error, issue_number: input.issueNumber }, 'handoff labelling failed')
    }
  }

  if (input.config.handoffClose === false) return

  try {
    // not_planned, so the issue shows GitHub's grey "closed as not planned"
    // icon rather than the tick that means shipped.
    await closeGitHubIssue(accessToken, ownerRepo, input.issueNumber, 'not_planned')
    log.info(
      { issue_number: input.issueNumber, post_id: input.postId },
      'imported issue handed off'
    )
  } catch (error) {
    log.error({ err: error, issue_number: input.issueNumber }, 'handoff close failed')
  }
}
