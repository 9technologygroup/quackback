/**
 * Data connectors: admin-defined external API calls the AI assistant can use
 * as tools (Data Connector v0). Each row becomes a model-facing tool named
 * `connector_{slug}` — connector.toolspec.ts owns that mapping; this table
 * only owns the definition and its runtime health (failure_count/status
 * mirror the webhook circuit breaker in events/process.ts).
 *
 * The secret is write-only: `secret_ciphertext` is AES-256-GCM encrypted
 * (purpose 'data-connector') and the service layer never decrypts it back
 * into a read DTO, only just-in-time when a call executes.
 */
import { pgTable, text, timestamp, jsonb, integer, boolean, index, check, foreignKey } from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'
import { typeIdWithDefault, typeIdColumnNullable } from '@quackback/ids/drizzle'
import { principal } from './auth'

export const CONNECTOR_METHODS = ['GET', 'POST'] as const
export type ConnectorMethod = (typeof CONNECTOR_METHODS)[number]

export const CONNECTOR_STATUSES = ['active', 'disabled'] as const
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number]

export const CONNECTOR_AUTH_TYPES = ['none', 'bearer', 'header', 'basic'] as const
export type ConnectorAuthType = (typeof CONNECTOR_AUTH_TYPES)[number]

/** One `{name, value}` pair sent as a request header; `value` may contain `{token}` placeholders. */
export interface ConnectorHeader {
  name: string
  value: string
}

/** How the decrypted secret (if any) is attached to the outbound request. */
export interface ConnectorAuthConfig {
  type: ConnectorAuthType
  /** Required when type is 'header': the header name the secret is sent under. */
  headerName?: string
}

export const CONNECTOR_INPUT_TYPES = ['string', 'number', 'boolean'] as const
export type ConnectorInputType = (typeof CONNECTOR_INPUT_TYPES)[number]

/** One model-facing input parameter, projected into the tool's zod input schema. */
export interface ConnectorInputField {
  name: string
  type: ConnectorInputType
  description?: string
  required?: boolean
}

export const dataConnectors = pgTable(
  'data_connectors',
  {
    id: typeIdWithDefault('data_connector')('id').primaryKey(),
    /** Admin-facing display name; also the uniqueness anchor `slug` derives from. */
    name: text('name').notNull().unique(),
    /** Derived from `name` at create; feeds the tool id `connector_{slug}`. */
    slug: text('slug').notNull().unique(),
    /** Model-facing: what the tool does, shown to the assistant as its tool description. */
    description: text('description').notNull(),
    method: text('method', { enum: CONNECTOR_METHODS }).notNull(),
    /** `{token}` placeholders resolved against declared inputs + builtins (connector.render.ts). */
    urlTemplate: text('url_template').notNull(),
    headers: jsonb('headers').$type<ConnectorHeader[]>().notNull().default([]),
    auth: jsonb('auth').$type<ConnectorAuthConfig>().notNull().default({ type: 'none' }),
    /** AES-256-GCM ciphertext (purpose 'data-connector'); never decrypted into a read DTO. */
    secretCiphertext: text('secret_ciphertext'),
    inputs: jsonb('inputs').$type<ConnectorInputField[]>().notNull().default([]),
    bodyTemplate: text('body_template'),
    /** Truncated sample captured by the last successful test call, shown in the admin UI. */
    exampleResponse: jsonb('example_response'),
    /** Dot-paths to project out of the response; unset means the whole body. */
    responsePaths: jsonb('response_paths').$type<string[]>(),
    timeoutMs: integer('timeout_ms').notNull().default(10000),
    /** Opt-in per connector: a connector only becomes a live tool once enabled. */
    enabled: boolean('enabled').notNull().default(false),
    /** Circuit breaker: auto-flips to 'disabled' at the failure threshold (connector.service.ts). */
    status: text('status', { enum: CONNECTOR_STATUSES }).notNull().default('active'),
    failureCount: integer('failure_count').notNull().default(0),
    lastError: text('last_error'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    createdById: typeIdColumnNullable('principal')('created_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'data_connectors_created_by_id_principal_id_fk',
      columns: [table.createdById],
      foreignColumns: [principal.id],
    }).onDelete('set null'),
    index('data_connectors_enabled_status_idx').on(table.enabled, table.status),
    check('data_connectors_method_check', sql`${table.method} IN ('GET','POST')`),
    check('data_connectors_status_check', sql`${table.status} IN ('active','disabled')`),
    check('data_connectors_timeout_ms_check', sql`${table.timeoutMs} <= 30000`),
  ]
)

export const dataConnectorsRelations = relations(dataConnectors, ({ one }) => ({
  createdBy: one(principal, {
    fields: [dataConnectors.createdById],
    references: [principal.id],
  }),
}))
