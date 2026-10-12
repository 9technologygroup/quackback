/**
 * Approvals: the queue of requests a person may decide, one request with its
 * diff, turning one down with a reason, and reading the approval bell.
 *
 * The base gate is a signed-in session; who may see or decide each request is
 * per row (the item's visibility and every permission the operation needs),
 * enforced by the approvals services. A decision that arrives here comes from
 * a person's session, never from the credential that filed the request. A
 * refusal the page can act on is returned as `{ ok: false, code, message }`.
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import type { AssistantPendingActionId } from '@quackback/ids'
import { requireAuth, policyActorFromAuth } from './auth-helpers'
import { approvalRefusal } from '@/lib/shared/approval-refusal'

const ApprovalInput = z.object({ approvalId: z.string() })

export const listApprovalsFn = createServerFn({ method: 'GET' })
  .validator(z.object({ limit: z.number().int().min(1).max(100).optional() }))
  .handler(async ({ data }) => {
    const auth = await requireAuth()
    const actor = await policyActorFromAuth(auth)
    const { listApprovalsForViewer } =
      await import('@/lib/server/domains/assistant/approvals.queue')
    return listApprovalsForViewer(actor, { limit: data.limit })
  })

export const getApprovalFn = createServerFn({ method: 'GET' })
  .validator(ApprovalInput)
  .handler(async ({ data }) => {
    const auth = await requireAuth()
    const actor = await policyActorFromAuth(auth)
    const { getApprovalForViewer } = await import('@/lib/server/domains/assistant/approvals.queue')
    return getApprovalForViewer(actor, data.approvalId as AssistantPendingActionId)
  })

export const rejectApprovalFn = createServerFn({ method: 'POST' })
  .validator(
    ApprovalInput.extend({
      contentHash: z.string().min(1).max(128),
      reason: z.string().max(500).optional(),
    })
  )
  .handler(async ({ data }) => {
    const auth = await requireAuth()
    const actor = await policyActorFromAuth(auth)
    const { rejectApproval } = await import('@/lib/server/domains/assistant/approvals.service')
    try {
      const row = await rejectApproval(actor, data.approvalId as AssistantPendingActionId, {
        contentHash: data.contentHash,
        reason: data.reason,
        via: 'app',
      })
      return {
        ok: true as const,
        id: row.id,
        status: row.status,
        decisionReason: row.decisionReason,
      }
    } catch (error) {
      // A refusal the page branches on travels as a value; see approvalRefusal.
      const refused = approvalRefusal(error)
      if (refused) return refused
      throw error
    }
  })

/**
 * Read the caller's own unread approval bell, for the approvals queue to call
 * when it opens: the bell counts requests since it was last read, and the
 * next one starts a new count. Acts only on the caller's own notifications.
 */
export const markApprovalBellReadFn = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{ marked: number }> => {
    const auth = await requireAuth()
    const { markApprovalBellsRead } =
      await import('@/lib/server/domains/notifications/notification.service')
    return { marked: await markApprovalBellsRead(auth.principal.id) }
  }
)
