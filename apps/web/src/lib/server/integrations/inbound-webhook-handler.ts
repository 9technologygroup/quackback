/**
 * Central inbound webhook orchestrator.
 *
 * Handles incoming webhooks from external platforms (Linear, GitHub, Jira, etc.)
 * by verifying signatures, parsing status changes, and updating post statuses.
 *
 * Loop prevention: outbound issue-tracking hooks only fire for `post.created` events,
 * so the `post.status_changed` event dispatched here won't re-trigger them.
 */

import {
  db,
  integrations,
  postExternalLinks,
  commentExternalLinks,
  integrationEventMappings,
  eq,
  and,
} from '@/lib/server/db'
import { getIntegration } from './index'
import { decryptSecrets } from './encryption'
import { resolveStatusMapping, type StatusMappings } from './status-mapping'
import { changeStatus } from '@/lib/server/domains/posts/post.status'
import type { PostId, StatusId, PrincipalId, BoardId, IntegrationId } from '@quackback/ids'
import type { InboundCreatePostIntent, InboundCreateCommentIntent } from './inbound-types'
import { MAX_POST_CONTENT_LENGTH } from '@/lib/shared/schemas/posts'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'inbound-webhook' })

/**
 * Handle an inbound webhook from an external platform.
 */
export async function handleInboundWebhook(
  request: Request,
  integrationType: string
): Promise<Response> {
  const definition = getIntegration(integrationType)
  if (!definition?.inbound) {
    return new Response('Unknown integration type', { status: 404 })
  }

  // Read raw body (needed for HMAC verification)
  const body = await request.text()

  // Get integration record
  const integration = await db.query.integrations.findFirst({
    where: and(
      eq(integrations.integrationType, integrationType),
      eq(integrations.status, 'active')
    ),
  })
  if (!integration) {
    return new Response('Integration not configured', { status: 404 })
  }

  const config = (integration.config ?? {}) as Record<string, unknown>
  const webhookSecret = config.webhookSecret as string | undefined
  if (!webhookSecret) {
    log.error({ integration_type: integrationType }, 'inbound webhook secret not configured')
    return new Response('Webhook not configured', { status: 404 })
  }

  // Verify signature — may return a Response for handshake/challenge or auth failure
  const verification = await definition.inbound.verifySignature(request, body, webhookSecret)
  if (verification !== true) {
    return verification
  }

  // Decrypt secrets so handlers can access OAuth tokens
  const secrets = integration.secrets ? decryptSecrets(integration.secrets) : {}

  // Parse the webhook payload for a status change
  const result = await definition.inbound.parseStatusChange(body, config, secrets)
  if (!result) {
    // Not a status change — try the create-post path (e.g. a GitHub issue
    // that was opened) for integrations that support inbound item creation.
    if (definition.inbound.parseCreatePost) {
      const createIntent = await definition.inbound.parseCreatePost(body, config, secrets)
      if (createIntent) {
        return handleInboundCreatePost(
          {
            id: integration.id as IntegrationId,
            principalId: integration.principalId as PrincipalId | null,
          },
          integrationType,
          config,
          createIntent,
          secrets
        )
      }
    }
    // Then the mirror-comment path (e.g. someone replied on a linked issue).
    if (definition.inbound.parseCreateComment) {
      const commentIntent = await definition.inbound.parseCreateComment(body, config, secrets)
      if (commentIntent) {
        return handleInboundCreateComment(
          {
            id: integration.id as IntegrationId,
            principalId: integration.principalId as PrincipalId | null,
          },
          integrationType,
          commentIntent
        )
      }
    }
    // Nothing to do — acknowledge but ignore
    return new Response('OK', { status: 200 })
  }

  log.info(
    {
      integration_type: integrationType,
      event_type: result.eventType,
      external_id: result.externalId,
      external_status: result.externalStatus,
    },
    'inbound status change received'
  )

  // Reverse lookup: find the post linked to this external ID
  const link = await db.query.postExternalLinks.findFirst({
    where: and(
      eq(postExternalLinks.integrationType, integrationType),
      eq(postExternalLinks.externalId, result.externalId)
    ),
  })
  if (!link) {
    log.debug(
      { integration_type: integrationType, external_id: result.externalId },
      'no linked post for external id, ignoring'
    )
    return new Response('OK', { status: 200 })
  }

  // Resolve status mapping
  const statusMappings = config.statusMappings as StatusMappings | undefined
  const statusId = resolveStatusMapping(result.externalStatus, statusMappings)
  if (!statusId) {
    log.debug(
      { integration_type: integrationType, external_status: result.externalStatus },
      'no status mapping, ignoring'
    )
    return new Response('OK', { status: 200 })
  }

  // Update the post status using the integration's service principal
  try {
    if (!integration.principalId) {
      log.error(
        { integration_type: integrationType },
        'integration has no service principal, skipping status update'
      )
      return new Response('OK', { status: 200 })
    }

    await changeStatus(link.postId as PostId, statusId as StatusId, {
      principalId: integration.principalId as PrincipalId,
      displayName: `${integrationType} Integration`,
    })
    log.info(
      { post_id: link.postId, status_id: statusId, integration_type: integrationType },
      'inbound status update applied'
    )
  } catch (error) {
    log.error({ err: error, integration_type: integrationType }, 'inbound status update failed')
    // Still return 200 to prevent the platform from retrying
  }

  return new Response('OK', { status: 200 })
}

/**
 * Create a Quackback post from a newly opened external item (e.g. a GitHub
 * issue), governed by a per-integration event-mapping toggle.
 *
 * Loop prevention: the post is created with `skipDispatch: true`, so the
 * `post.created` event never fires — the outbound issue-tracking hook (which
 * would otherwise create a *new* external issue) is not triggered.
 *
 * The reporter is attributed as author, but the create runs with a team-role
 * actor so the board's "signed-in only" submit gate and moderation approval
 * are bypassed — a trusted server-side flow authenticated by the webhook HMAC.
 */
async function handleInboundCreatePost(
  integration: { id: IntegrationId; principalId: PrincipalId | null },
  integrationType: string,
  config: Record<string, unknown>,
  intent: InboundCreatePostIntent,
  secrets: Record<string, unknown> = {}
): Promise<Response> {
  // 1. Toggle gate — only act when an admin has enabled this event mapping.
  const mapping = await db.query.integrationEventMappings.findFirst({
    where: and(
      eq(integrationEventMappings.integrationId, integration.id),
      eq(integrationEventMappings.eventType, intent.eventType),
      eq(integrationEventMappings.enabled, true)
    ),
    columns: { id: true },
  })
  if (!mapping) {
    log.debug(
      { integration_type: integrationType, event_type: intent.eventType },
      'inbound create-post disabled, ignoring'
    )
    return new Response('OK', { status: 200 })
  }

  // 2. Target board — required to create a post.
  const boardId = config.inboundBoardId as string | undefined
  if (!boardId) {
    log.warn(
      { integration_type: integrationType },
      'inbound create-post enabled but no inboundBoardId configured, ignoring'
    )
    return new Response('OK', { status: 200 })
  }

  // 3. Idempotency — skip if this external item already maps to a post
  //    (webhook redelivery, or already brought in by the migration).
  const existing = await db.query.postExternalLinks.findFirst({
    where: and(
      eq(postExternalLinks.integrationType, integrationType),
      eq(postExternalLinks.externalId, intent.externalId)
    ),
    columns: { id: true },
  })
  if (existing) {
    log.debug(
      { integration_type: integrationType, external_id: intent.externalId },
      'external item already linked to a post, skipping create'
    )
    return new Response('OK', { status: 200 })
  }

  const { createPost } = await import('@/lib/server/domains/posts/post.service')
  const { linkTicketToPost } = await import('./apps/service')
  const { segmentIdsForPrincipal } =
    await import('@/lib/server/domains/segments/segment-membership.service')

  // 4. Resolve author. Reporter resolution is provider-specific, so it's gated
  //    by integration type; other integrations fall back to the service principal.
  let authorPrincipalId: PrincipalId
  if (intent.reporter && integrationType === 'github') {
    const { resolveGitHubReporterPrincipal } = await import('./github/reporter-resolver')
    authorPrincipalId = await resolveGitHubReporterPrincipal(intent.reporter)
  } else if (integration.principalId) {
    authorPrincipalId = integration.principalId
  } else {
    log.error(
      { integration_type: integrationType },
      'no resolvable reporter and no service principal; skipping create'
    )
    return new Response('OK', { status: 200 })
  }

  const segmentIds = await segmentIdsForPrincipal(authorPrincipalId)
  const actor = {
    principalId: authorPrincipalId,
    role: 'member' as const,
    principalType: 'service' as const,
    segmentIds,
  }

  // Wrap create + link so a config error (e.g. a deleted board) returns 200
  // rather than 500 — a 500 would flag the whole GitHub webhook as failing.
  try {
    const created = await createPost(
      {
        boardId: boardId as BoardId,
        title: intent.title.slice(0, 200),
        content: (intent.body ?? '').slice(0, MAX_POST_CONTENT_LENGTH),
      },
      { principalId: authorPrincipalId, actor },
      { skipDispatch: true }
    )

    // 5. Link the post to the external item so subsequent close/reopen webhooks
    //    sync its status and repeat deliveries stay idempotent.
    await linkTicketToPost(
      {
        postId: created.id as PostId,
        integrationId: integration.id,
        integrationType,
        externalId: intent.externalId,
        externalUrl: intent.externalUrl,
      },
      authorPrincipalId
    )

    log.info(
      {
        post_id: created.id,
        external_id: intent.externalId,
        integration_type: integrationType,
      },
      'inbound create-post applied'
    )

    // 6. Hand the conversation over on the source platform: point the reporter
    //    at the post and close the original, so the request is tracked in one
    //    place. Deliberately after the link is written — a failure here leaves
    //    a working post with a still-open issue, which is recoverable by hand,
    //    whereas closing first could strand a closed issue with no post.
    if (integrationType === 'github') {
      const { handoffImportedGitHubIssue } = await import('./github/import-handoff')
      await handoffImportedGitHubIssue({
        config,
        secrets,
        issueNumber: intent.externalId,
        postId: created.id as PostId,
        boardSlug: created.boardSlug,
      })
    }
  } catch (error) {
    log.error(
      { err: error, integration_type: integrationType, external_id: intent.externalId },
      'inbound create-post failed'
    )
  }

  return new Response('OK', { status: 200 })
}

/**
 * Mirror a comment made on an external item onto the Quackback post linked to
 * that item, governed by a per-integration event-mapping toggle.
 *
 * Loop prevention hinges on ordering. The comment is created with
 * `skipDispatch: true`, its external link (direction `inbound`) is written,
 * and only *then* is `comment.created` announced. Dispatching first would let
 * the outbound hook run before the link exists, see no inbound marker, and
 * push the comment straight back to the platform it came from.
 *
 * Announcing rather than staying silent is deliberate: subscribers watching
 * the post in Quackback still get notified about replies made on GitHub, which
 * is the whole point of mirroring. `skipDispatch` also suppresses
 * auto-subscribing the author, which is right here — synthetic
 * `@users.noreply.github.com` addresses would only bounce.
 */
async function handleInboundCreateComment(
  integration: { id: IntegrationId; principalId: PrincipalId | null },
  integrationType: string,
  intent: InboundCreateCommentIntent
): Promise<Response> {
  // 1. Toggle gate — only act when an admin has enabled this event mapping.
  const mapping = await db.query.integrationEventMappings.findFirst({
    where: and(
      eq(integrationEventMappings.integrationId, integration.id),
      eq(integrationEventMappings.eventType, intent.eventType),
      eq(integrationEventMappings.enabled, true)
    ),
    columns: { id: true },
  })
  if (!mapping) {
    log.debug(
      { integration_type: integrationType, event_type: intent.eventType },
      'inbound create-comment disabled, ignoring'
    )
    return new Response('OK', { status: 200 })
  }

  // 2. Idempotency — GitHub redelivers on timeout; the unique constraint on
  //    (integration_type, external_id) is the backstop, this is the fast path.
  const alreadyMirrored = await db.query.commentExternalLinks.findFirst({
    where: and(
      eq(commentExternalLinks.integrationType, integrationType),
      eq(commentExternalLinks.externalId, intent.externalId)
    ),
    columns: { id: true },
  })
  if (alreadyMirrored) {
    log.debug(
      { integration_type: integrationType, external_id: intent.externalId },
      'external comment already mirrored, skipping'
    )
    return new Response('OK', { status: 200 })
  }

  // 3. Resolve the post from the external item the comment belongs to. No
  //    link means the issue was never brought into Quackback — nothing to do.
  const link = await db.query.postExternalLinks.findFirst({
    where: and(
      eq(postExternalLinks.integrationType, integrationType),
      eq(postExternalLinks.externalId, intent.externalParentId)
    ),
    columns: { postId: true },
  })
  if (!link) {
    log.debug(
      { integration_type: integrationType, external_parent_id: intent.externalParentId },
      'no linked post for external item, ignoring comment'
    )
    return new Response('OK', { status: 200 })
  }

  // 4. Resolve author, same tiering as the create-post path.
  let authorPrincipalId: PrincipalId
  if (intent.reporter && integrationType === 'github') {
    const { resolveGitHubReporterPrincipal } = await import('./github/reporter-resolver')
    authorPrincipalId = await resolveGitHubReporterPrincipal(intent.reporter)
  } else if (integration.principalId) {
    authorPrincipalId = integration.principalId
  } else {
    log.error(
      { integration_type: integrationType },
      'no resolvable commenter and no service principal; skipping comment'
    )
    return new Response('OK', { status: 200 })
  }

  const { createComment } = await import('@/lib/server/domains/comments/comment.service')
  const { announcePublishedComment } =
    await import('@/lib/server/domains/comments/comment.announce')
  const { recordCommentLink } = await import('./github/comment-sync')
  const { segmentIdsForPrincipal } =
    await import('@/lib/server/domains/segments/segment-membership.service')

  const segmentIds = await segmentIdsForPrincipal(authorPrincipalId)

  try {
    const created = await createComment(
      {
        postId: link.postId as PostId,
        content: (intent.body ?? '').slice(0, 5000),
      },
      { principalId: authorPrincipalId, role: 'user' },
      {
        principalId: authorPrincipalId,
        role: 'member',
        principalType: 'service',
        segmentIds,
      },
      { skipDispatch: true }
    )

    // Write the link BEFORE announcing — see the note above.
    await recordCommentLink({
      commentId: created.comment.id,
      integrationId: integration.id,
      externalId: intent.externalId,
      externalUrl: intent.externalUrl,
      direction: 'inbound',
    })

    await announcePublishedComment(created.comment.id)

    log.info(
      {
        comment_id: created.comment.id,
        post_id: link.postId,
        external_id: intent.externalId,
        integration_type: integrationType,
      },
      'inbound comment mirrored'
    )
  } catch (error) {
    log.error(
      { err: error, integration_type: integrationType, external_id: intent.externalId },
      'inbound create-comment failed'
    )
  }

  return new Response('OK', { status: 200 })
}
