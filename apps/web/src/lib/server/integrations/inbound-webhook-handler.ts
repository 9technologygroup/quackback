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
  integrationEventMappings,
  eq,
  and,
} from '@/lib/server/db'
import { getIntegration } from './index'
import { decryptSecrets } from './encryption'
import { resolveStatusMapping, type StatusMappings } from './status-mapping'
import { changeStatus } from '@/lib/server/domains/posts/post.status'
import type { PostId, StatusId, PrincipalId, BoardId, IntegrationId } from '@quackback/ids'
import type { InboundCreatePostIntent } from './inbound-types'
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
          { id: integration.id as IntegrationId, principalId: integration.principalId as PrincipalId | null },
          integrationType,
          config,
          createIntent
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
  intent: InboundCreatePostIntent
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
  const { segmentIdsForPrincipal } = await import(
    '@/lib/server/domains/segments/segment-membership.service'
  )

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
        content: (intent.body ?? '').slice(0, 10000),
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
  } catch (error) {
    log.error(
      { err: error, integration_type: integrationType, external_id: intent.externalId },
      'inbound create-post failed'
    )
  }

  return new Response('OK', { status: 200 })
}
