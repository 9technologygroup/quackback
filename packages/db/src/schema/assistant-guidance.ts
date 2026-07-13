/** Situational guidance selected for an eligible assistant role and channel. */
import { pgTable, text, boolean, integer, timestamp, index, check } from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'
import { typeIdWithDefault, typeIdColumnNullable } from '@quackback/ids/drizzle'
import { principal } from './auth'

export const assistantGuidanceRules = pgTable(
  'assistant_guidance_rules',
  {
    id: typeIdWithDefault('assistant_guidance')('id').primaryKey(),
    name: text('name').notNull(),
    appliesWhen: text('applies_when'),
    instruction: text('instruction').notNull(),
    roles: text('roles').array().notNull().default(['customer_support', 'suggested_reply']),
    enabled: boolean('enabled').notNull().default(true),
    // NULL = every eligible channel; otherwise an allowlist of assistant surfaces.
    channels: text('channels').array(),
    // Lower values run first. This preserves the V1 position ordering.
    priority: integer('priority').notNull().default(0),
    // Nulled on the author's deletion — the rule outlives them.
    createdById: typeIdColumnNullable('principal')('created_by_id').references(() => principal.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('assistant_guidance_rules_enabled_priority_idx').on(table.enabled, table.priority),
    check(
      'assistant_guidance_rules_name_length_check',
      sql`char_length(${table.name}) BETWEEN 1 AND 80`
    ),
    check(
      'assistant_guidance_rules_applies_when_length_check',
      sql`${table.appliesWhen} IS NULL OR char_length(${table.appliesWhen}) BETWEEN 1 AND 500`
    ),
    check(
      'assistant_guidance_rules_instruction_length_check',
      sql`char_length(${table.instruction}) BETWEEN 1 AND 1000`
    ),
    check(
      'assistant_guidance_rules_roles_length_check',
      sql`cardinality(${table.roles}) BETWEEN 1 AND 3`
    ),
  ]
)

export const assistantGuidanceRulesRelations = relations(assistantGuidanceRules, ({ one }) => ({
  createdBy: one(principal, {
    fields: [assistantGuidanceRules.createdById],
    references: [principal.id],
  }),
}))
