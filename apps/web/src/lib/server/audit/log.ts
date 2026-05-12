/**
 * Append-only audit log helper.
 *
 * One call per security-sensitive admin action. Best-effort: insert
 * failures are logged and swallowed so the primary mutation isn't
 * blocked by audit-log downtime. Callers must not rely on the row
 * being visible to a subsequent SELECT in the same transaction —
 * inserts are made on the global connection, not the caller's tx.
 *
 * Mirrors the shape of the audit helper on feat/sso-enforcement-v0.11.
 * When that branch lands in main, the two AuditEventType unions will
 * be merged; the helper signature is identical.
 */
import { db, auditLog } from '@/lib/server/db'
import type { UserId } from '@quackback/ids'
import { getClientIp } from '@/lib/server/domains/api/rate-limit'
import type { AuthContext } from '@/lib/server/functions/auth-helpers'

/** A JSON-shaped value — fits into a Postgres jsonb column. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[]

/**
 * Closed taxonomy of audit event types.
 *
 * Add new entries as features land. Existing rows reference the
 * string literal directly so reordering / renaming is a schema-level
 * change — never reuse a retired identifier.
 */
export type AuditEventType =
  // v1 access controls
  | 'board.audience.changed'
  | 'board.moderation.changed'
  | 'post.moderation.approved'
  | 'post.moderation.rejected'
  | 'segment.member.added'
  | 'segment.member.removed'
  | 'segment.sso_mapping.changed'

export type AuditEventOutcome = 'success' | 'failure'

export interface AuditActor {
  userId?: UserId | null
  email?: string | null
  role?: string | null
}

export interface AuditTarget {
  type: string
  id?: string | null
}

export interface RecordAuditEventInput {
  event: AuditEventType
  outcome?: AuditEventOutcome
  actor: AuditActor
  /** Optional Request — IP comes from `getClientIp`, UA from `user-agent`. */
  request?: Request
  target?: AuditTarget
  before?: unknown
  after?: unknown
  metadata?: Record<string, unknown>
}

/** Map a requireAuth() result onto the audit row's denormalised actor fields. */
export function actorFromAuth(auth: AuthContext): AuditActor {
  return { userId: auth.user.id, email: auth.user.email, role: auth.principal.role }
}

export async function recordAuditEvent(input: RecordAuditEventInput): Promise<void> {
  const ip = input.request ? getClientIp(input.request) : null
  const userAgent = input.request?.headers.get('user-agent') ?? null

  try {
    await db.insert(auditLog).values({
      eventType: input.event,
      eventOutcome: input.outcome ?? 'success',
      actorUserId: input.actor.userId ?? null,
      actorEmail: input.actor.email ?? null,
      actorRole: input.actor.role ?? null,
      actorIp: ip === 'unknown' ? null : ip,
      actorUserAgent: userAgent,
      targetType: input.target?.type ?? null,
      targetId: input.target?.id ?? null,
      beforeValue: input.before ?? null,
      afterValue: input.after ?? null,
      metadata: input.metadata ?? null,
    })
  } catch (error) {
    console.error('[audit] recordAuditEvent failed:', { event: input.event, error })
  }
}
