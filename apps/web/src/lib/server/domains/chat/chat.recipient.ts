/**
 * Resolve the email address an agent reply should be sent to when the visitor
 * is offline. Pure so the precedence is unit-tested directly. An identified
 * visitor's account email is preferred; otherwise the pre-chat email they
 * captured on the conversation. (P1.8 extends this with a principal-level
 * contact email between the two.)
 */
export function resolveReplyRecipient(
  visitor: { type: string; email: string | null } | undefined | null,
  capturedEmail: string | null | undefined
): string | null {
  if (visitor && visitor.type !== 'anonymous' && visitor.email) return visitor.email
  return capturedEmail ?? null
}
