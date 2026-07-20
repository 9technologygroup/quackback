/**
 * Widget-facing ticket server functions (widget ticket submission). The widget
 * iframe is same-origin with the app and authenticates with a Better Auth
 * session token as `Authorization: Bearer` (resolved transparently by the
 * bearer plugin), so these thin wrappers delegate to the ownership-gated
 * `requester.service` exactly like the portal requester fns — no `/api/widget/*`
 * REST routes, no re-implemented auth/validation (D1).
 *
 * Unlike the portal fns, every widget fn consults the `isWidgetTicketsEnabled()`
 * choke point (fail-closed) so a disabled Tickets module rejects calls even from
 * a stale client, and enforces the two identity tiers (D3): a verified principal
 * gets full in-widget tracking; an anonymous visitor gets the email-capture tier
 * — the New-Ticket form requires an email, captured overwrite-once onto their
 * existing anonymous principal, after which updates continue over email.
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import type { TicketId } from '@quackback/ids'
import type { Actor } from '@/lib/server/policy/types'
import type { ConversationAttachment } from '@/lib/shared/db-types'
import { ForbiddenError } from '@/lib/shared/errors'
import { requireAuth, policyActorFromAuth } from './auth-helpers'

// Redefined identically to the agent-facing `sendTicketMessageSchema`
// (functions/tickets.ts) so the widget wire shape can't drift; the service
// re-validates count/size/url of every attachment.
const ticketAttachmentSchema = z.object({
  url: z.string(),
  name: z.string().optional(),
  contentType: z.string().optional(),
  size: z.number(),
})

const replySchema = z.object({
  ticketId: z.string(),
  // Empty is valid for an image/embed-only rich message; the service re-validates.
  content: z.string().default(''),
  contentJson: z.any().nullable().optional(),
  attachments: z.array(ticketAttachmentSchema).optional(),
})

/**
 * The shared widget-ticket gate: the `isWidgetTicketsEnabled()` choke point +
 * `requireAuth()` + the two-tier identity check. Verified principals always
 * pass. An anonymous principal passes when a `contactEmail` is already captured,
 * or (create only, `allowEmailCapture`) when the request supplies a plausible
 * email to capture; otherwise `EMAIL_REQUIRED`. Tier is read from the resolved
 * `Actor.principalType` (never a raw principal string — auth-helpers warns that
 * collapsing anonymous is a security bug). Defense-in-depth: the requester
 * service enforces the same contact-channel guard at the write layer.
 */
async function requireWidgetTicketActor(opts?: {
  allowEmailCapture?: boolean
  suppliedEmail?: string
}): Promise<{ actor: Actor }> {
  const { isWidgetTicketsEnabled } = await import('@/lib/server/domains/settings/settings.support')
  if (!(await isWidgetTicketsEnabled())) {
    throw new ForbiddenError('FORBIDDEN', 'Tickets are not available')
  }
  const ctx = await requireAuth()
  const actor = await policyActorFromAuth(ctx)
  if (actor.principalType === 'anonymous') {
    const { requesterHasContactChannel, isPlausibleContactEmail } =
      await import('@/lib/server/domains/tickets/requester.service')
    const hasEmail = await requesterHasContactChannel(actor)
    const suppliesEmail = !!opts?.allowEmailCapture && isPlausibleContactEmail(opts?.suppliedEmail)
    if (!hasEmail && !suppliesEmail) {
      throw new ForbiddenError(
        'EMAIL_REQUIRED',
        'An email address is required to file or track a ticket'
      )
    }
  }
  return { actor }
}

/**
 * The customer intake shape the New-Ticket form renders (convergence Phase 4):
 * the live, intake-visible customer types, each carrying its customer-visible
 * fields (sorted by `order`). The form shows a type picker when more than one
 * type is offered; a single-type workspace behaves exactly like the legacy
 * fixed form. Read shape only — no stored values.
 */
export const getWidgetTicketFormFn = createServerFn({ method: 'GET' }).handler(async () => {
  // The form shape must be reachable by an anonymous visitor who has not yet
  // captured an email (they need it to fill the email-capture form), so this
  // path consults the choke point + a valid session but not the email tier.
  const { isWidgetTicketsEnabled } = await import('@/lib/server/domains/settings/settings.support')
  if (!(await isWidgetTicketsEnabled())) {
    throw new ForbiddenError('FORBIDDEN', 'Tickets are not available')
  }
  await requireAuth()
  const svc = await import('@/lib/server/domains/tickets/ticket-type-intake.service')
  const types = await svc.listIntakeTypes()
  return { types: types.map((t) => svc.ticketTypeToIntakeDTO(t)) }
})

/** The current widget visitor's own customer tickets, newest activity first. */
export const listMyWidgetTicketsFn = createServerFn({ method: 'GET' }).handler(async () => {
  const { actor } = await requireWidgetTicketActor()
  const { listMyTickets } = await import('@/lib/server/domains/tickets/requester.service')
  return listMyTickets(actor)
})

/** A single ticket the visitor owns as requester (header + status + stage). */
export const getMyWidgetTicketFn = createServerFn({ method: 'GET' })
  .validator(z.object({ ticketId: z.string() }))
  .handler(async ({ data }) => {
    const { actor } = await requireWidgetTicketActor()
    const { getMyTicket } = await import('@/lib/server/domains/tickets/requester.service')
    return getMyTicket(actor, data.ticketId as TicketId)
  })

/**
 * The workspace's requester-facing stage labels (customized via ticket
 * settings) for the widget ticket StageTracker — the same `getStageLabels()`
 * the stage chips and emails already read (B19: the tracker hardcoded the
 * DEFAULT labels while chips/emails used the customized ones). The labels are
 * customer-visible content the visitor already sees on their own tickets'
 * chips, so the standard widget-ticket gate (feature flag + identity tier) is
 * the whole check.
 */
export const getMyWidgetTicketStageLabelsFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    await requireWidgetTicketActor()
    const { getStageLabels } = await import('@/lib/server/domains/settings/settings.tickets')
    return getStageLabels()
  }
)

/** The customer-visible thread of a ticket the visitor owns (internal notes stripped). */
export const getMyWidgetTicketThreadFn = createServerFn({ method: 'GET' })
  .validator(z.object({ ticketId: z.string(), before: z.string().optional() }))
  .handler(async ({ data }) => {
    const { actor } = await requireWidgetTicketActor()
    const { getMyTicketThread } = await import('@/lib/server/domains/tickets/requester.service')
    return getMyTicketThread(actor, data.ticketId as TicketId, { before: data.before })
  })

/** The visitor marks their own ticket read (opening its widget ticket detail).
 *  CONVERGENCE PHASE 2 (read-through): on a linked pair this writes the
 *  CONVERSATION's visitor watermark — the pair's Messages-tab row + the
 *  messenger badge read it, so one read clears both spaces. */
export const markMyWidgetTicketReadFn = createServerFn({ method: 'POST' })
  .validator(z.object({ ticketId: z.string() }))
  .handler(async ({ data }) => {
    const { actor } = await requireWidgetTicketActor()
    const { markMyTicketRead } = await import('@/lib/server/domains/tickets/requester.service')
    await markMyTicketRead(actor, data.ticketId as TicketId)
    return { ok: true }
  })

/** The visitor replies on their own ticket thread (a customer-visible message). */
export const replyToMyWidgetTicketFn = createServerFn({ method: 'POST' })
  .validator(replySchema)
  .handler(async ({ data }) => {
    const { actor } = await requireWidgetTicketActor()
    const { replyToMyTicket } = await import('@/lib/server/domains/tickets/requester.service')
    return replyToMyTicket(actor, {
      ticketId: data.ticketId as TicketId,
      content: data.content,
      contentJson: data.contentJson ?? null,
      attachments: data.attachments as ConversationAttachment[] | undefined,
    })
  })

const createSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(4000).optional(),
  // Empty is valid for an image/embed-only opening message; the service re-validates.
  descriptionJson: z.any().nullable().optional(),
  attachments: z.array(ticketAttachmentSchema).optional(),
  // The registry type filed under (Phase 4); absent = the customer-category
  // default type. Must be live + intake-visible (enforced server-side).
  ticketTypeId: z.string().optional(),
  // Custom intake-form answers; validated against the chosen type's form.
  fieldValues: z.record(z.string(), z.unknown()).optional(),
  // Email-capture tier: an anonymous visitor supplies the address the ticket's
  // updates will reach; captured overwrite-once onto their principal.
  email: z.string().optional(),
})

/** The visitor opens their own customer ticket from the widget. */
export const createMyWidgetTicketFn = createServerFn({ method: 'POST' })
  .validator(createSchema)
  .handler(async ({ data }) => {
    const { actor } = await requireWidgetTicketActor({
      allowEmailCapture: true,
      suppliedEmail: data.email,
    })

    // Capture the supplied email onto the (anonymous) principal first — overwrite-
    // once, so it never replaces an address already on file. The service guard
    // then finds a contact channel and lets the create through.
    if (actor.principalType === 'anonymous' && data.email && actor.principalId) {
      const { captureRequesterEmail } =
        await import('@/lib/server/domains/tickets/requester.service')
      await captureRequesterEmail(actor.principalId, data.email)
    }

    // Resolve the type (explicit or the customer-category default) and
    // validate the submitted answers server-side against its customer form
    // (client inline validation and this share the one validator, so they
    // can't drift). Keys not on the form or not visibleToCustomer are dropped.
    const svc = await import('@/lib/server/domains/tickets/ticket-type-intake.service')
    const intake = await svc.resolveIntakeCreate(data.ticketTypeId, data.fieldValues)

    const { createMyTicket } = await import('@/lib/server/domains/tickets/requester.service')
    return createMyTicket(actor, {
      title: data.title,
      description: data.description,
      descriptionJson: data.descriptionJson ?? null,
      attachments: data.attachments as ConversationAttachment[] | undefined,
      ticketTypeId: intake.ticketTypeId,
      customAttributes: intake.customAttributes,
    })
  })
