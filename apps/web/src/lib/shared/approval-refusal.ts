import { DomainException } from './errors'

/**
 * A decision the server refused for a reason the person can act on (the
 * request changed, an admin or a fresh sign-in is needed, the requester
 * cannot decide it), returned as a value. A thrown error reaches the client
 * with its message only, so the code a card branches on would be lost.
 */
export interface ApprovalRefusal {
  ok: false
  code: string
  message: string
}

/**
 * The code every decision surface uses when the person must sign in again
 * first, whichever rule asked for it, so one sign-in-again step answers it.
 */
export const RECENT_SIGN_IN_REQUIRED = 'RECENT_SIGN_IN_REQUIRED'

/** The refusal a domain error carries, or null for a failure nobody can act on. */
export function approvalRefusal(error: unknown): ApprovalRefusal | null {
  if (!(error instanceof DomainException)) return null
  const code = error.code === 'APPROVAL_SIGN_IN_REQUIRED' ? RECENT_SIGN_IN_REQUIRED : error.code
  return { ok: false, code, message: error.message }
}
