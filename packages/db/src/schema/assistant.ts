import { pgTable, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { typeIdWithDefault, typeIdColumn } from '@quackback/ids/drizzle'
import { conversations } from './conversation'

/**
 * Assistant involvement record — the audit/KPI unit for the in-product AI
 * agent (Quinn). One row per conversation the assistant engages, carrying how
 * it was triggered, its terminal status, the structured hand-off reason (if
 * any), the sources it cited, and a CSAT rating once the assistant was the last
 * handler. Turn-level detail (tool calls, tokens) lives on message metadata and
 * `ai_usage_log`; this table is the reporting spine.
 */

/** How the assistant came to engage a conversation. */
export const ASSISTANT_INVOLVEMENT_TRIGGERS = ['first_touch', 'workflow', 'agent_handback'] as const

/**
 * Terminal lifecycle of one involvement. `resolved_confirmed` = explicit
 * customer affirmation; `resolved_assumed` = customer inactivity after a real
 * answer. At most one resolution per conversation.
 */
export const ASSISTANT_INVOLVEMENT_STATUSES = [
  'active',
  'handed_off',
  'resolved_confirmed',
  'resolved_assumed',
  'abandoned',
] as const

/** Structured reason the assistant decided to hand off (it decides THAT, never WHERE). */
export const ASSISTANT_HANDOFF_REASONS = [
  'explicit_request',
  'frustration',
  'repetition',
  'low_confidence',
  'safety',
] as const

export type AssistantInvolvementTrigger = (typeof ASSISTANT_INVOLVEMENT_TRIGGERS)[number]
export type AssistantInvolvementStatus = (typeof ASSISTANT_INVOLVEMENT_STATUSES)[number]
export type AssistantHandoffReason = (typeof ASSISTANT_HANDOFF_REASONS)[number]

/** One cited source captured on an involvement (a help-center article or a feedback post). */
export interface AssistantInvolvementSource {
  type: 'article' | 'post'
  id: string
  title?: string
  url?: string
}

export const assistantInvolvements = pgTable(
  'assistant_involvements',
  {
    id: typeIdWithDefault('assistant_involvement')('id').primaryKey(),
    conversationId: typeIdColumn('conversation')('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    triggeredBy: text('triggered_by', { enum: ASSISTANT_INVOLVEMENT_TRIGGERS }).notNull(),
    status: text('status', { enum: ASSISTANT_INVOLVEMENT_STATUSES }).notNull().default('active'),
    handoffReason: text('handoff_reason', { enum: ASSISTANT_HANDOFF_REASONS }),
    sources: jsonb('sources').$type<AssistantInvolvementSource[]>().notNull().default([]),
    rating: integer('rating'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [index('assistant_involvements_conversation_id_idx').on(t.conversationId)]
)

export const assistantInvolvementsRelations = relations(assistantInvolvements, ({ one }) => ({
  conversation: one(conversations, {
    fields: [assistantInvolvements.conversationId],
    references: [conversations.id],
  }),
}))
