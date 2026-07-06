/**
 * Client-safe ticket helpers (support platform §4.2): the reference formatter,
 * the requester-facing stage labels, the status-category labels, and the
 * per-type custom-form field shape + its validation schema.
 *
 * No server/db imports — the admin settings UI, the customer New-Ticket form,
 * and the DTO builder all import from here, so it must stay bundleable into the
 * client. Persistence lives in the server-only
 * `domains/settings/settings.tickets.ts` family, which parses against the same
 * schema defined here.
 */
import { z } from 'zod'
import type { TicketType, TicketStage, TicketStatusCategory } from '@/lib/shared/db-types'

/** Render a ticket's sequential number for display (plain `#142`). */
export function formatTicketNumber(n: number): string {
  return `#${n}`
}

/** The workspace's default closed-category ticket status (unified inbox §3.4:
 *  "close"/"Resolve" maps to it for a ticket target) — the status marked
 *  `isDefault` within the closed category, or else the first closed status by
 *  position. Undefined when the workspace has no closed status configured at
 *  all. Shared by the inbox route's bulk/solo close and the unified thread
 *  header's primary Resolve button, so the resolution rule can't drift. */
export function resolveDefaultClosedStatusId(
  statuses: { id: string; category: string; isDefault: boolean }[] | undefined
): string | undefined {
  if (!statuses) return undefined
  const closed = statuses.filter((s) => s.category === 'closed')
  return closed.find((s) => s.isDefault)?.id ?? closed[0]?.id
}

/** Customer-facing labels for the four requester stages. */
export type TicketStageLabels = Record<TicketStage, string>

/** Defaults shown to requesters when a workspace has not customized the labels. */
export const DEFAULT_TICKET_STAGE_LABELS: TicketStageLabels = {
  received: 'Received',
  in_progress: 'In progress',
  awaiting_requester: 'Awaiting your reply',
  resolved: 'Resolved',
}

/**
 * Display labels for the three status categories. The single source shared by the
 * settings status list, the workspace list-column filter, and the status chips.
 */
export const TICKET_STATUS_CATEGORY_LABELS: Record<TicketStatusCategory, string> = {
  open: 'Open',
  pending: 'Pending',
  closed: 'Closed',
}

/** The input controls a custom ticket-form field can render as. */
export const TICKET_FORM_FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'select',
  'date',
  'checkbox',
] as const
export type TicketFormFieldType = (typeof TICKET_FORM_FIELD_TYPES)[number]

/**
 * One configurable field on a ticket type's intake form. `visibleToCustomer`
 * decides whether it appears on the customer New-Ticket form; `options` is only
 * meaningful for `select`.
 */
export interface TicketFormField {
  key: string
  label: string
  type: TicketFormFieldType
  required: boolean
  visibleToCustomer: boolean
  order: number
  options?: string[]
}

/**
 * Validation for one intake-form field. The single source both the client editor
 * (inline validation) and the server write path parse against, so the two never
 * drift. A `select` field must define at least one option.
 */
export const ticketFormFieldSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_]+$/, 'Key must be lowercase letters, digits, and underscores'),
    label: z.string().trim().min(1).max(120),
    type: z.enum(TICKET_FORM_FIELD_TYPES),
    required: z.boolean(),
    visibleToCustomer: z.boolean(),
    order: z.number().int(),
    options: z.array(z.string().trim().min(1)).optional(),
  })
  .refine((f) => f.type !== 'select' || (f.options?.length ?? 0) > 0, {
    message: 'A select field must define at least one option',
    path: ['options'],
  })

/** A full intake form: an ordered field list rejecting duplicate keys. */
export const ticketFormSchema = z.array(ticketFormFieldSchema).superRefine((fields, ctx) => {
  const seen = new Set<string>()
  for (const f of fields) {
    if (seen.has(f.key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate field key '${f.key}'` })
    }
    seen.add(f.key)
  }
})

/** The intake form for each ticket type (empty array = no custom fields). */
export type TicketForms = Record<TicketType, TicketFormField[]>

/** An empty form for every ticket type — the read-time default. */
export const DEFAULT_TICKET_FORMS: TicketForms = {
  customer: [],
  back_office: [],
  tracker: [],
}
