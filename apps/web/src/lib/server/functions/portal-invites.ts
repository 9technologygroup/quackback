/**
 * Server functions for portal email invites.
 *
 * Provides admin-only operations for sending, cancelling, resending, and
 * listing portal-access invitations, plus the invitee-facing accept function.
 * A portal invite lets an admin grant a specific person access to a private
 * portal without adding them to the team.
 *
 * The accept flow (magic-link callback) calls acceptPortalInviteFn from the
 * portal-invite.$inviteId route.
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import type { InviteId, UserId } from '@quackback/ids'
import { generateId } from '@quackback/ids'
import { db, invitation, principal, user, eq, and, or, sql } from '@/lib/server/db'
import { requireAuth } from './auth-helpers'
import { actorFromAuth, recordAuditEvent } from '@/lib/server/audit/log'
import { getBaseUrl } from '@/lib/server/config'
import { sendPortalInviteEmail } from '@quackback/email'
import { getSession } from '@/lib/server/auth/session'

/** Portal invite lifetime — 14 days. */
const PORTAL_INVITE_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const sendPortalInviteSchema = z.object({
  email: z.string().email(),
})

const portalInviteByIdSchema = z.object({
  inviteId: z.string(),
})

// ---------------------------------------------------------------------------
// Internal helper — mint a magic link for a portal invite
// ---------------------------------------------------------------------------

async function mintPortalInviteMagicLink(
  email: string,
  inviteId: string,
  portalUrl: string
): Promise<string> {
  const { mintMagicLinkUrl } = await import('@/lib/server/auth/magic-link-mint')
  return mintMagicLinkUrl({
    email,
    callbackPath: `/portal-invite/${inviteId}`,
    portalUrl,
    // Portal invite links live for the invite's full lifetime; a 10-minute
    // magic-link token is enough since the invitee clicks it promptly after
    // receiving the email. The invite row itself governs long-term access.
    expiresInSeconds: 10 * 60,
  })
}

// ---------------------------------------------------------------------------
// sendPortalInviteFn
// ---------------------------------------------------------------------------

/**
 * Send a portal-access invitation to the given email address.
 *
 * Rejects when:
 *   - The email already belongs to a team member (they already have access).
 *   - A pending portal invite for that email already exists.
 *
 * Inserts an `invitation` row with `kind='portal'`, mints a magic-link, and
 * sends the portal-invite email. Records a `portal.invite.sent` audit event.
 */
export const sendPortalInviteFn = createServerFn({ method: 'POST' })
  .inputValidator(sendPortalInviteSchema)
  .handler(async ({ data }) => {
    const auth = await requireAuth({ roles: ['admin'] })
    const email = data.email.toLowerCase().trim()
    const headers = getRequestHeaders()
    const actor = actorFromAuth(auth)

    console.log(`[fn:portal-invites] sendPortalInviteFn: email=${email}`)

    // Reject if the email already belongs to a team member.
    const existingTeamUser = await db.query.user.findFirst({
      where: eq(user.email, email),
    })
    if (existingTeamUser) {
      const existingPrincipal = await db.query.principal.findFirst({
        where: eq(principal.userId, existingTeamUser.id),
      })
      if (
        existingPrincipal &&
        (existingPrincipal.role === 'admin' || existingPrincipal.role === 'member')
      ) {
        throw new Error('This person is already a team member and has access to the portal.')
      }
    }

    // Reject if a pending portal invite already exists.
    const existingInvite = await db.query.invitation.findFirst({
      where: and(
        eq(invitation.email, email),
        eq(invitation.kind, 'portal'),
        eq(invitation.status, 'pending')
      ),
    })
    if (existingInvite) {
      throw new Error('A pending portal invitation has already been sent to this email address.')
    }

    const inviteId = generateId('invite')
    const now = new Date()
    const expiresAt = new Date(now.getTime() + PORTAL_INVITE_EXPIRY_MS)

    await db.insert(invitation).values({
      id: inviteId,
      email,
      name: null,
      role: null,
      kind: 'portal',
      status: 'pending',
      expiresAt,
      createdAt: now,
      lastSentAt: now,
      inviterId: auth.user.id as UserId,
    })

    const portalUrl = getBaseUrl()
    const inviteLink = await mintPortalInviteMagicLink(email, inviteId, portalUrl)

    const { getEmailSafeUrl } = await import('@/lib/server/storage/s3')
    const logoUrl = getEmailSafeUrl(auth.settings.logoKey) ?? undefined
    const result = await sendPortalInviteEmail({
      to: email,
      workspaceName: auth.settings.name,
      inviteLink,
      logoUrl,
    })

    await recordAuditEvent({
      event: 'portal.invite.sent',
      actor,
      headers,
      target: { type: 'invitation', id: inviteId },
      after: { email, kind: 'portal' },
    })

    console.log(
      `[fn:portal-invites] sendPortalInviteFn: ${result.sent ? 'sent' : 'created (email not configured)'} id=${inviteId}`
    )
    return { inviteId, emailSent: result.sent, inviteLink: !result.sent ? inviteLink : undefined }
  })

// ---------------------------------------------------------------------------
// cancelPortalInviteFn
// ---------------------------------------------------------------------------

/**
 * Cancel a pending portal invite.
 *
 * The invite must be `kind='portal'` and not already in a terminal state
 * (accepted | canceled). Records a `portal.invite.revoked` audit event.
 */
export const cancelPortalInviteFn = createServerFn({ method: 'POST' })
  .inputValidator(portalInviteByIdSchema)
  .handler(async ({ data }) => {
    const auth = await requireAuth({ roles: ['admin'] })
    const inviteId = data.inviteId as InviteId
    const headers = getRequestHeaders()
    const actor = actorFromAuth(auth)

    console.log(`[fn:portal-invites] cancelPortalInviteFn: id=${inviteId}`)

    const inv = await db.query.invitation.findFirst({
      where: and(eq(invitation.id, inviteId), eq(invitation.kind, 'portal')),
    })

    if (!inv) {
      throw new Error('Portal invitation not found.')
    }
    if (inv.status !== 'pending') {
      throw new Error(`Cannot cancel an invitation that is already ${inv.status}.`)
    }

    await db
      .update(invitation)
      .set({ status: 'canceled' })
      .where(and(eq(invitation.id, inviteId), eq(invitation.kind, 'portal')))

    await recordAuditEvent({
      event: 'portal.invite.revoked',
      actor,
      headers,
      target: { type: 'invitation', id: inviteId },
      before: { email: inv.email, status: 'pending' },
      after: { email: inv.email, status: 'canceled' },
    })

    console.log(`[fn:portal-invites] cancelPortalInviteFn: canceled`)
    return { inviteId }
  })

// ---------------------------------------------------------------------------
// resendPortalInviteFn
// ---------------------------------------------------------------------------

/**
 * Resend a portal invite email.
 *
 * The invite must be `kind='portal'`, `status='pending'`, and not expired.
 * Mints a fresh magic link, updates `lastSentAt`, and re-sends the email.
 * Records `portal.invite.sent` (re-use — a resend is another send).
 */
export const resendPortalInviteFn = createServerFn({ method: 'POST' })
  .inputValidator(portalInviteByIdSchema)
  .handler(async ({ data }) => {
    const auth = await requireAuth({ roles: ['admin'] })
    const inviteId = data.inviteId as InviteId
    const headers = getRequestHeaders()
    const actor = actorFromAuth(auth)

    console.log(`[fn:portal-invites] resendPortalInviteFn: id=${inviteId}`)

    const inv = await db.query.invitation.findFirst({
      where: and(
        eq(invitation.id, inviteId),
        eq(invitation.kind, 'portal'),
        eq(invitation.status, 'pending')
      ),
    })

    if (!inv) {
      throw new Error('Portal invitation not found or is not pending.')
    }

    if (new Date(inv.expiresAt) < new Date()) {
      throw new Error('This invitation has expired. Please cancel it and send a new one.')
    }

    const portalUrl = getBaseUrl()
    const inviteLink = await mintPortalInviteMagicLink(inv.email, inviteId, portalUrl)

    const { getEmailSafeUrl } = await import('@/lib/server/storage/s3')
    const logoUrl = getEmailSafeUrl(auth.settings.logoKey) ?? undefined
    const result = await sendPortalInviteEmail({
      to: inv.email,
      workspaceName: auth.settings.name,
      inviteLink,
      logoUrl,
    })

    await db
      .update(invitation)
      .set({ lastSentAt: new Date() })
      .where(and(eq(invitation.id, inviteId), eq(invitation.kind, 'portal')))

    await recordAuditEvent({
      event: 'portal.invite.sent',
      actor,
      headers,
      target: { type: 'invitation', id: inviteId },
      metadata: { resend: true, email: inv.email },
    })

    console.log(
      `[fn:portal-invites] resendPortalInviteFn: ${result.sent ? 'resent' : 'regenerated (email not configured)'}`
    )
    return { inviteId, emailSent: result.sent, inviteLink: !result.sent ? inviteLink : undefined }
  })

// ---------------------------------------------------------------------------
// fetchPortalInvitesFn
// ---------------------------------------------------------------------------

/**
 * List portal invites for the admin UI.
 *
 * Returns only `kind='portal'` rows — pending first (by sent date desc),
 * then recently-accepted/revoked — capped at 100 rows.
 */
export const fetchPortalInvitesFn = createServerFn({ method: 'GET' }).handler(async () => {
  await requireAuth({ roles: ['admin'] })

  console.log(`[fn:portal-invites] fetchPortalInvitesFn`)

  const rows = await db.query.invitation.findMany({
    where: and(
      eq(invitation.kind, 'portal'),
      or(
        eq(invitation.status, 'pending'),
        eq(invitation.status, 'accepted'),
        eq(invitation.status, 'canceled')
      )
    ),
    orderBy: [
      // Pending first — active invites are most actionable.
      sql`CASE WHEN "invitation"."status" = 'pending' THEN 0 ELSE 1 END`,
      sql`"invitation"."last_sent_at" DESC NULLS LAST`,
      sql`"invitation"."created_at" DESC`,
    ],
    limit: 100,
  })

  return rows.map((inv) => ({
    id: inv.id,
    email: inv.email,
    status: inv.status,
    kind: inv.kind,
    createdAt: inv.createdAt.toISOString(),
    lastSentAt: inv.lastSentAt?.toISOString() ?? null,
    expiresAt: inv.expiresAt.toISOString(),
  }))
})

// ---------------------------------------------------------------------------
// acceptPortalInviteFn
// ---------------------------------------------------------------------------

/**
 * Discriminated result from acceptPortalInviteFn.
 *
 * The route renders a user-facing message for every non-accepted state;
 * on `accepted` it redirects to `/` so the portal gate grants entry.
 */
export type AcceptPortalInviteResult =
  | { status: 'accepted'; alreadyAccepted: boolean }
  | { status: 'canceled' }
  | { status: 'expired' }
  | { status: 'mismatch' }

/**
 * Accept a portal-access invitation for the currently signed-in user.
 *
 * Requires an authenticated session (any role — the invitee just signed in
 * via the magic-link and may not yet have a principal record).
 *
 * Validates the invite and returns a discriminated result:
 *   - `accepted`  — invite was pending + email matched → status set to accepted.
 *   - `accepted` (alreadyAccepted) — idempotent re-visit; no second audit event.
 *   - `canceled`  — invite was revoked before the invitee clicked.
 *   - `expired`   — invite's expiresAt is in the past.
 *   - `mismatch`  — session email does not match the invite email (case-insensitive).
 *
 * Throws on missing session (unauthenticated) or invite not found.
 */
export const acceptPortalInviteFn = createServerFn({ method: 'POST' })
  .inputValidator(portalInviteByIdSchema)
  .handler(async ({ data }): Promise<AcceptPortalInviteResult> => {
    const inviteId = data.inviteId as InviteId
    const headers = getRequestHeaders()

    console.log(`[fn:portal-invites] acceptPortalInviteFn: id=${inviteId}`)

    // Portal invitees may not have a principal record yet — use getSession()
    // directly instead of requireAuth() to avoid the principal existence check.
    const session = await getSession()
    if (!session?.user) {
      throw new Error('Authentication required')
    }

    const sessionEmail = session.user.email?.toLowerCase()
    if (!sessionEmail) {
      throw new Error('Session has no email address')
    }

    const inv = await db.query.invitation.findFirst({
      where: and(eq(invitation.id, inviteId), eq(invitation.kind, 'portal')),
    })

    if (!inv) {
      throw new Error('PORTAL_INVITE_NOT_FOUND')
    }

    // Email mismatch — check first, before any status short-circuit, so a
    // caller signed in as the wrong account always gets `mismatch` regardless
    // of whether the invite has already been accepted.
    if (inv.email.toLowerCase() !== sessionEmail) {
      console.warn(
        `[fn:portal-invites] acceptPortalInviteFn: email mismatch invite=${inv.email} session=${sessionEmail}`
      )
      return { status: 'mismatch' }
    }

    // Idempotent: already accepted — no second audit event.
    if (inv.status === 'accepted') {
      console.log(`[fn:portal-invites] acceptPortalInviteFn: already accepted`)
      return { status: 'accepted', alreadyAccepted: true }
    }

    if (inv.status === 'canceled') {
      console.log(`[fn:portal-invites] acceptPortalInviteFn: invite is canceled`)
      return { status: 'canceled' }
    }

    if (new Date(inv.expiresAt) < new Date()) {
      console.log(`[fn:portal-invites] acceptPortalInviteFn: invite is expired`)
      return { status: 'expired' }
    }

    // All checks passed — accept the invite.
    await db
      .update(invitation)
      .set({ status: 'accepted' })
      .where(and(eq(invitation.id, inviteId), eq(invitation.kind, 'portal')))

    // Build a minimal actor from the session for the audit row.
    const principalRecord = await db.query.principal.findFirst({
      where: eq(principal.userId, session.user.id as UserId),
      columns: { id: true, role: true, type: true },
    })
    const actor = {
      userId: session.user.id as UserId,
      email: session.user.email,
      role: principalRecord?.role ?? 'user',
    }

    await recordAuditEvent({
      event: 'portal.invite.accepted',
      actor,
      headers,
      target: { type: 'invitation', id: inviteId },
      after: { email: inv.email, kind: 'portal' },
    })

    console.log(`[fn:portal-invites] acceptPortalInviteFn: accepted id=${inviteId}`)
    return { status: 'accepted', alreadyAccepted: false }
  })
