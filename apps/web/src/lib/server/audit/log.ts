/**
 * Append-only audit log helper.
 *
 * One call per security-sensitive admin action. Best-effort: insert
 * failures are logged and swallowed so the primary mutation isn't
 * blocked by audit-log downtime. Callers must not rely on the row
 * being visible to a subsequent SELECT in the same transaction —
 * inserts are made on the global connection, not the caller's tx.
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
  | 'sso.enforcement.domain.enabled'
  | 'sso.enforcement.domain.disabled'
  | 'sso.enforcement.workspace_required.enabled'
  | 'sso.enforcement.workspace_required.disabled'
  | 'sso.config.changed'
  | 'sso.recovery_codes.generated'
  | 'sso.recovery_codes.used'
  | 'sso.recovery_codes.invalidated'
  | 'auth.password.enabled'
  | 'auth.password.disabled'
  | 'auth.magic_link.enabled'
  | 'auth.magic_link.disabled'
  | 'auth.method.blocked'
  | 'session.revoked.bulk'
  | 'user.role.changed'
  | 'user.invited'
  | 'user.removed'
  | 'two_factor.reset_by_admin'
  | 'two_factor.enabled'
  | 'two_factor.disabled'

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
  /** Request headers — IP comes from `getClientIp`, UA from `user-agent`. */
  headers?: Headers
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
  const ip = input.headers ? getClientIp(input.headers) : null
  const userAgent = input.headers?.get('user-agent') ?? null

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

/**
 * Wrap a mutation with success/failure audit-log emission. Records a
 * success row on resolve and a failure row (with `reason` derived from
 * the error's `code` or message) on throw, then rethrows the original
 * error.
 *
 * Use for handlers that need symmetric success/failure trails —
 * setVerifiedDomainEnforcedFn, set/clearSsoClientSecretFn, etc.
 * For success-only audits (admin reset 2FA, generate codes) call
 * `recordAuditEvent` directly after the mutation succeeds.
 */
/** Cap on the `metadata.reason` extracted from thrown errors. */
const MAX_REASON_LEN = 200

/**
 * Derive a stable, length-capped `reason` string from a thrown error.
 *
 * Prefers `error.code` (typed Quackback errors like ValidationError /
 * ForbiddenError set this to a stable identifier). Falls back to a
 * truncated `error.message` so messages don't leak full backtraces or
 * unbounded user input into the audit row.
 */
function extractReason(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code).slice(0, MAX_REASON_LEN)
  }
  if (error instanceof Error) {
    return error.message.slice(0, MAX_REASON_LEN)
  }
  return 'UNEXPECTED'
}

export async function withAuditEvent<T>(
  spec: {
    event: AuditEventType
    actor: AuditActor
    target?: AuditTarget
    before?: unknown
    after?: unknown
    metadata?: Record<string, unknown>
    headers?: Headers
  },
  mutation: () => Promise<T>
): Promise<T> {
  try {
    const result = await mutation()
    await recordAuditEvent({
      event: spec.event,
      outcome: 'success',
      actor: spec.actor,
      target: spec.target,
      before: spec.before,
      after: spec.after,
      metadata: spec.metadata,
      headers: spec.headers,
    })
    return result
  } catch (error) {
    await recordAuditEvent({
      event: spec.event,
      outcome: 'failure',
      actor: spec.actor,
      target: spec.target,
      before: spec.before,
      after: spec.after,
      metadata: { ...(spec.metadata ?? {}), reason: extractReason(error) },
      headers: spec.headers,
    })
    throw error
  }
}
