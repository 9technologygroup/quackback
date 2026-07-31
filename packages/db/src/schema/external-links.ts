import { pgTable, text, timestamp, varchar, index, unique, foreignKey } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { typeIdWithDefault, typeIdColumn, typeIdColumnNullable } from '@quackback/ids/drizzle'
import { posts, comments } from './posts'
import { integrations } from './integrations'

/**
 * External links between posts and external platform issues/tickets.
 * Created when an outbound hook creates an issue in an external tracker,
 * or when a support agent links a ticket to a post via the sidebar app.
 * Used for reverse lookups when inbound webhooks report status changes.
 */
export const postExternalLinks = pgTable(
  'post_external_links',
  {
    id: typeIdWithDefault('linked_entity')('id').primaryKey(),
    postId: typeIdColumn('post')('post_id').notNull(),
    // Nullable: sidebar-created links don't require a full integration record
    integrationId: typeIdColumnNullable('integration')('integration_id'),
    integrationType: varchar('integration_type', { length: 50 }).notNull(),
    externalId: text('external_id').notNull(),
    /** Human-friendly display label (e.g. "QUA-24", "#142"). Falls back to externalId when null. */
    externalDisplayId: text('external_display_id'),
    externalUrl: text('external_url'),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'post_external_links_post_fk',
      columns: [table.postId],
      foreignColumns: [posts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'post_external_links_integration_fk',
      columns: [table.integrationId],
      foreignColumns: [integrations.id],
    }).onDelete('cascade'),
    // Allow one ticket to link to multiple posts (unique per type+externalId+postId)
    unique('post_external_links_type_external_post_unique').on(
      table.integrationType,
      table.externalId,
      table.postId
    ),
    index('post_external_links_post_id_idx').on(table.postId),
    index('post_external_links_type_external_id_idx').on(table.integrationType, table.externalId),
    index('post_external_links_post_status_idx').on(table.postId, table.status),
  ]
)

// Relations
export const postExternalLinksRelations = relations(postExternalLinks, ({ one }) => ({
  post: one(posts, {
    fields: [postExternalLinks.postId],
    references: [posts.id],
  }),
  integration: one(integrations, {
    fields: [postExternalLinks.integrationId],
    references: [integrations.id],
  }),
}))

/**
 * External links between comments and external platform comments, for
 * two-way comment mirroring (currently GitHub issue comments).
 *
 * Serves three jobs at once:
 *  - **Echo guard.** A row with `direction: 'inbound'` marks a comment that
 *    originated externally, so the outbound hook knows not to send it back.
 *    The inbound path writes this row *before* dispatching `comment.created`
 *    (see the GitHub inbound handler) — dispatching first would race the
 *    outbound hook and loop.
 *  - **Idempotency.** `(integration_type, external_id)` is unique, so webhook
 *    redelivery is a no-op rather than a duplicate comment.
 *  - **Traceability.** Links each side to the other for debugging.
 */
export const commentExternalLinks = pgTable(
  'comment_external_links',
  {
    id: typeIdWithDefault('linked_entity')('id').primaryKey(),
    commentId: typeIdColumn('comment')('comment_id').notNull(),
    integrationId: typeIdColumnNullable('integration')('integration_id'),
    integrationType: varchar('integration_type', { length: 50 }).notNull(),
    /** Provider-side comment id (e.g. GitHub issue-comment id). */
    externalId: text('external_id').notNull(),
    externalUrl: text('external_url'),
    /**
     * Which way this comment travelled. 'inbound' = created on the external
     * platform and mirrored into Quackback; 'outbound' = authored in Quackback
     * and pushed out. Only 'inbound' suppresses outbound sync.
     */
    direction: varchar('direction', { length: 10 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'comment_external_links_comment_fk',
      columns: [table.commentId],
      foreignColumns: [comments.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'comment_external_links_integration_fk',
      columns: [table.integrationId],
      foreignColumns: [integrations.id],
    }).onDelete('cascade'),
    // One external comment maps to exactly one Quackback comment — this is the
    // idempotency guarantee for webhook redelivery.
    unique('comment_external_links_type_external_unique').on(
      table.integrationType,
      table.externalId
    ),
    // Echo-guard lookup: "does this comment already have an inbound link?"
    index('comment_external_links_comment_id_idx').on(table.commentId),
  ]
)

export const commentExternalLinksRelations = relations(commentExternalLinks, ({ one }) => ({
  comment: one(comments, {
    fields: [commentExternalLinks.commentId],
    references: [comments.id],
  }),
  integration: one(integrations, {
    fields: [commentExternalLinks.integrationId],
    references: [integrations.id],
  }),
}))
