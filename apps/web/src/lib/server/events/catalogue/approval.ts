/**
 * Approval events: a person is asked to decide a change, decides it, and the
 * approved change is applied. The subject is the pending action. Webhooks get
 * all three so an agent that filed a request can wait on its outcome; the
 * request also rings the bell of everyone who may decide it.
 */
import { decl } from './helpers'

const S = 'workspace'

export const approvalRequested = decl(
  'approval.requested',
  'assistant_action',
  { webhook: true, notification: 'approval_requested' },
  S
)
export const approvalDecided = decl('approval.decided', 'assistant_action', { webhook: true }, S)
export const approvalApplied = decl('approval.applied', 'assistant_action', { webhook: true }, S)
