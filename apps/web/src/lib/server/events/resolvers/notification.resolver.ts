/**
 * Notification sink resolver (EVENTING-V2 WO-8c) — the per-user fan-out:
 * subscriber email + in-app, @-mentions, changelog subscribers, and status-page
 * subscribers, each with their own audience gating and the notification
 * preference matrix.
 *
 * This is the trickiest sink, so the transitional implementation DELEGATES to
 * the already-tested builders in targets.ts (via the reconstructed EventData +
 * hook context) rather than re-porting ~700 lines and risking a parity gap. The
 * WO-15 shadow-diff validates equivalence; Phase 5 folds the builders in and
 * deletes targets.ts. See to-legacy-event.ts for the actor-fidelity caveat.
 */
import { buildHookContext } from '../hook-context'
import { toLegacyEvent } from '../to-legacy-event'
import {
  SUBSCRIBER_EVENT_TYPES,
  MENTION_EVENT_TYPES,
  getSubscriberTargets,
  getMentionTargets,
  getChangelogSubscriberTargets,
  getStatusSubscriberTargets,
} from '../targets'
import { logger } from '@/lib/server/logger'
import type { SinkResolver } from './registry'
import type { DomainEvent } from '../envelope'
import type { HookTarget } from '../hook-types'

const log = logger.child({ component: 'notification-resolver' })

const SUBSCRIBER_SET = new Set<string>(SUBSCRIBER_EVENT_TYPES)
const MENTION_SET = new Set<string>(MENTION_EVENT_TYPES)
/** Status publish events that drive the status-subscription fan-out. */
const STATUS_NOTIFY_SET = new Set<string>([
  'status.incident_created',
  'status.maintenance_scheduled',
])

export const notificationResolver: SinkResolver = {
  sink: 'notification',
  interestedIn(type: string): boolean {
    return SUBSCRIBER_SET.has(type) || MENTION_SET.has(type) || STATUS_NOTIFY_SET.has(type)
  },
  async resolve(event: DomainEvent): Promise<HookTarget[]> {
    try {
      const context = await buildHookContext()
      if (!context) return []
      const legacy = toLegacyEvent(event)
      const out: HookTarget[] = []

      if (SUBSCRIBER_SET.has(event.type)) {
        out.push(
          ...(event.type === 'changelog.published'
            ? await getChangelogSubscriberTargets(legacy, context)
            : await getSubscriberTargets(legacy, context))
        )
      }
      if (MENTION_SET.has(event.type)) {
        out.push(...(await getMentionTargets(legacy, context)))
      }
      if (STATUS_NOTIFY_SET.has(event.type)) {
        out.push(...(await getStatusSubscriberTargets(legacy, context)))
      }
      return out
    } catch (error) {
      log.error({ err: error, type: event.type }, 'failed to resolve notification targets')
      return []
    }
  },
}
