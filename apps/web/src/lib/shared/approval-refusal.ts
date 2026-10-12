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

/** The refusal a domain error carries, or null for a failure nobody can act on. */
export function approvalRefusal(error: unknown): ApprovalRefusal | null {
  return error instanceof DomainException
    ? { ok: false, code: error.code, message: error.message }
    : null
}
