/**
 * Webhook sink resolver (EVENTING-V2 WO-8a) — the DomainEvent-native port of
 * getWebhookTargets() from targets.ts. Behavior-preserving: same active-webhook
 * cache, same event-type + board-overlap match, same private-comment guard,
 * same {type:'webhook', target:{url}, config:{webhookId}} target shape (the
 * signing secret stays out of the payload; the delivery handler decrypts it
 * just-in-time by id).
 */
import { db, webhooks, posts, and, eq, isNull } from '@/lib/server/db'
import { cacheGet, cacheSet, CACHE_KEYS } from '@/lib/server/cache'
import { getEventDefinition } from '../catalogue'
import type { SinkResolver } from './registry'
import type { DomainEvent } from '../envelope'
import type { HookTarget } from '../hook-types'
import type { PostId, WebhookId } from '@quackback/ids'

type WebhookRow = typeof webhooks.$inferSelect

/**
 * Board id(s) the event is about, dug from the DomainEvent payload. Merge/unmerge
 * carry two posts (possibly on different boards); board-less events return [].
 */
export function boardIdsFromEvent(event: DomainEvent): string[] {
  const p = event.payload as Record<string, unknown>
  const boardOf = (o: unknown): string | undefined =>
    o && typeof o === 'object' && typeof (o as { boardId?: unknown }).boardId === 'string'
      ? (o as { boardId: string }).boardId
      : undefined

  if (event.type === 'post.merged' || event.type === 'post.unmerged') {
    const ids = new Set(
      [
        boardOf(p.duplicatePost),
        boardOf(p.canonicalPost),
        boardOf(p.post),
        boardOf(p.formerCanonicalPost),
      ].filter((x): x is string => !!x)
    )
    return [...ids]
  }
  // Post-scoped events nest the post; the self-contained mention and owner
  // events carry the board id at the top level.
  const b = boardOf(p.post) ?? (typeof p.boardId === 'string' ? p.boardId : undefined)
  return b ? [b] : []
}

/**
 * Whether a webhook subscribes to this event. Mirrors webhookSubscriptionMatches:
 * board filter applies only to board-bearing events; board-less events (conversation,
 * ticket, ...) match on event-type subscription alone even if the webhook has a board filter.
 */
export function webhookMatches(
  webhook: { events: string[]; boardIds: string[] | null },
  type: string,
  boardIds: string[]
): boolean {
  if (!webhook.events.includes(type)) return false
  if (webhook.boardIds && webhook.boardIds.length > 0 && boardIds.length > 0) {
    if (!boardIds.some((id) => webhook.boardIds!.includes(id))) return false
  }
  return true
}

/** Private comments never leave to external webhooks. */
function isPrivateComment(event: DomainEvent): boolean {
  if (
    event.type !== 'comment.created' &&
    event.type !== 'comment.updated' &&
    event.type !== 'comment.deleted'
  ) {
    return false
  }
  const c = (event.payload as { comment?: { isPrivate?: boolean } }).comment
  return c?.isPrivate === true
}

/** Post-scoped events whose payload is flat: the board id rides beside the post id. */
function needsBoardLookup(event: DomainEvent): boolean {
  return (
    (event.type === 'post.mentioned' || event.type === 'post.owner_assigned') &&
    typeof (event.payload as { postId?: unknown }).postId === 'string'
  )
}

async function loadActiveWebhooks(): Promise<WebhookRow[]> {
  const cached = await cacheGet<WebhookRow[]>(CACHE_KEYS.ACTIVE_WEBHOOKS)
  if (cached) return cached
  const rows = await db.query.webhooks.findMany({
    where: and(eq(webhooks.status, 'active'), isNull(webhooks.deletedAt)),
  })
  await cacheSet(CACHE_KEYS.ACTIVE_WEBHOOKS, rows, 300)
  return rows
}

export const webhookResolver: SinkResolver = {
  sink: 'webhook',
  interestedIn(type: string): boolean {
    return getEventDefinition(type)?.exposure.webhook ?? false
  },
  async resolve(event: DomainEvent): Promise<HookTarget[]> {
    if (isPrivateComment(event)) return []
    const active = await loadActiveWebhooks()
    if (active.length === 0) return []
    let boardIds = boardIdsFromEvent(event)
    // Mention and owner events queued before their payload carried a board
    // are placed by their post. A post that is gone has no board to match, so
    // only webhooks with no board filter hear of it.
    const boardUnknown = boardIds.length === 0 && needsBoardLookup(event)
    if (boardUnknown) {
      const postId = (event.payload as { postId: string }).postId
      const row = await db.query.posts.findFirst({
        where: eq(posts.id, postId as PostId),
        columns: { boardId: true },
      })
      if (row) boardIds = [row.boardId]
    }
    const unplaceable = boardUnknown && boardIds.length === 0
    return active
      .filter((w) => !(unplaceable && w.boardIds && w.boardIds.length > 0))
      .filter((w) => webhookMatches(w, event.type, boardIds))
      .map((w) => ({
        type: 'webhook',
        target: { url: w.url },
        config: { webhookId: w.id as WebhookId },
        deliveryKey: w.id,
      }))
  },
}
