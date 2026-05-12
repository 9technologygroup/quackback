/**
 * Audit log of security-sensitive admin actions.
 *
 * Append-only record of every change to authentication policy, access
 * controls, moderation decisions, and segment memberships. Read by
 * compliance reviewers and surfaced in the admin UI as a paginated,
 * filterable feed.
 *
 * Actor identity is denormalised (email, role) so removed admins still
 * leave a coherent trace; `actor_user_id` is nullable so user deletion
 * preserves the audit row.
 *
 * NOTE: a fuller version of this schema lives on feat/sso-enforcement-v0.11
 * (introduced for SSO compliance). This file is the OSS-main-compatible
 * variant. When the SSO branch lands in main, reconcile by replacing this
 * with the broader SSO version — column shape is identical so it's a
 * symbol-level merge, not a data migration.
 */
import { pgTable, text, timestamp, index, jsonb } from 'drizzle-orm/pg-core'
import { typeIdWithDefault, typeIdColumnNullable } from '@quackback/ids/drizzle'
import { user } from './auth'

export const auditLog = pgTable(
  'audit_log',
  {
    id: typeIdWithDefault('audit')('id').primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null when the actor's user row has been deleted. */
    actorUserId: typeIdColumnNullable('user')('actor_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    /** Denormalised so deletions don't anonymise old rows. */
    actorEmail: text('actor_email'),
    /** Actor's role at write time ('admin' | 'member' | 'user' | 'service'). */
    actorRole: text('actor_role'),
    actorIp: text('actor_ip'),
    actorUserAgent: text('actor_user_agent'),
    /** Dotted taxonomy — see `AuditEventType` in apps/web/src/lib/server/audit/log.ts. */
    eventType: text('event_type').notNull(),
    /** 'success' | 'failure'. */
    eventOutcome: text('event_outcome').notNull().default('success'),
    /** What was acted on — e.g. 'board', 'post', 'segment'. */
    targetType: text('target_type'),
    targetId: text('target_id'),
    beforeValue: jsonb('before_value'),
    afterValue: jsonb('after_value'),
    metadata: jsonb('metadata'),
  },
  (table) => [
    index('audit_log_occurred_at_idx').on(table.occurredAt),
    index('audit_log_actor_user_id_occurred_at_idx').on(table.actorUserId, table.occurredAt),
    index('audit_log_event_type_occurred_at_idx').on(table.eventType, table.occurredAt),
  ]
)
