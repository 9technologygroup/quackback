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
import { QUACKBACK_MARKER } from './message'
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

  const labels = Array.isArray(input.config.handoffLabels)
    ? input.config.handoffLabels.filter((l): l is string => typeof l === 'string' && l.length > 0)
    : []

  await handoffGitHubIssue({
    accessToken,
    ownerRepo,
    issueNumber: input.issueNumber,
    postId: input.postId,
    boardSlug: input.boardSlug,
    messageTemplate:
      typeof input.config.handoffMessage === 'string' && input.config.handoffMessage.trim()
        ? input.config.handoffMessage
        : undefined,
    labels,
    close: input.config.handoffClose !== false,
  })
}

/**
 * Build the handoff comment for a post, substituting the portal link.
 *
 * Guarantees the result carries {@link QUACKBACK_MARKER}. That marker is how the
 * inbound handler recognises its own writes echoing back, and a `{{url}}` that
 * expands to a bare link does not contain it — so the marker is appended
 * whenever substitution alone did not produce one. Getting this wrong leaves
 * only the author-login check standing between the handoff comment and being
 * mirrored back onto the post it just announced.
 */
export function buildHandoffMessage(postUrl: string, template?: string): string {
  const body = template?.trim() ? template : DEFAULT_MESSAGE
  const substituted = body.includes('{{url}}') ? body.replaceAll('{{url}}', postUrl) : body
  return substituted.includes(QUACKBACK_MARKER)
    ? substituted
    : `${substituted}\n\n[View in Quackback](${postUrl})`
}

/**
 * Comment on, label and close a single GitHub issue that now lives in Quackback.
 *
 * Takes credentials directly rather than reading config, so the bulk import
 * worker — which already holds a decrypted token and makes its own per-job
 * decision about whether to hand off — can call it without reconstructing an
 * integration config it never had.
 *
 * Each step is independent: a failed comment must not stop the close, and a
 * failed close must not lose the comment. Everything is logged and swallowed,
 * because the post and its link already exist by this point.
 */
export async function handoffGitHubIssue(input: {
  accessToken: string
  ownerRepo: string
  issueNumber: string
  postId: PostId
  boardSlug: string
  messageTemplate?: string
  labels?: string[]
  close?: boolean
}): Promise<void> {
  const postUrl = buildPostUrl(appConfig.baseUrl, input.boardSlug, input.postId)
  const message = buildHandoffMessage(postUrl, input.messageTemplate)

  try {
    await postGitHubIssueComment(input.accessToken, input.ownerRepo, input.issueNumber, message)
  } catch (error) {
    log.error({ err: error, issue_number: input.issueNumber }, 'handoff comment failed')
  }

  if (input.labels?.length) {
    try {
      await addGitHubIssueLabels(
        input.accessToken,
        input.ownerRepo,
        input.issueNumber,
        input.labels
      )
    } catch (error) {
      log.error({ err: error, issue_number: input.issueNumber }, 'handoff labelling failed')
    }
  }

  if (input.close === false) return

  try {
    // not_planned, so the issue shows GitHub's grey "closed as not planned"
    // icon rather than the tick that means shipped.
    await closeGitHubIssue(input.accessToken, input.ownerRepo, input.issueNumber, 'not_planned')
    log.info(
      { issue_number: input.issueNumber, post_id: input.postId },
      'imported issue handed off'
    )
  } catch (error) {
    log.error({ err: error, issue_number: input.issueNumber }, 'handoff close failed')
  }
}
