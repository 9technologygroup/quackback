/**
 * Undoing a settings receipt: the audit row of a direct write, or an approval
 * a person decided.
 */
import { and, auditLog, assistantPendingActions, db, eq, settings } from '@/lib/server/db'
import { ConflictError, NotFoundError } from '@/lib/shared/errors'
import { settingsReceiptIdSchema, type SettingsArea } from '@/lib/shared/settings-registry'
import { recordAuditEventInTransaction } from '@/lib/server/audit/log'
import { invalidateSettingsCache } from '@/lib/server/domains/settings/settings.helpers'
import { requireAreaPermission } from '@/lib/server/domains/assistant/settings-proposals.areas'
import type { SettingsApplyReceipt } from '@/lib/server/domains/assistant/settings-proposals.storage'
import {
  enqueueWorkspaceSettingsProposal,
  undoWorkspaceSettingsProposal,
} from '@/lib/server/domains/assistant/workspace-settings-actions.service'
import { settingsProposalRisk } from '@/lib/server/domains/assistant/approval-policy'
import { getSettingsArea, parseAreaPatch } from './registry'
import { auditActor, filedApproval, type FiledApproval, type SettingsCaller } from './service'

export interface UndoSettingsResult {
  id: string
  area: SettingsArea | null
  undone: true
  undoneAt: string
}

export type UndoSettingsOutcome =
  | { status: 'undone'; result: UndoSettingsResult }
  | { status: 'approval_required'; approval: FiledApproval }

/**
 * Undo a receipt while the values it wrote have not moved. A receipt is the
 * audit row of a direct (low-risk) write, or an approval a person decided.
 *
 * Undoing an approved change that touched a medium-risk or higher area is
 * itself a change to that area, so unless a signed-in person asks, the inverse
 * is filed as a new approval instead of being applied.
 */
export async function undoSettingsReceipt(
  caller: SettingsCaller,
  receiptId: string
): Promise<UndoSettingsOutcome> {
  const { actor } = caller
  const parsed = settingsReceiptIdSchema.safeParse(receiptId)
  if (!parsed.success)
    throw new NotFoundError('SETTINGS_RECEIPT_NOT_FOUND', 'Settings receipt not found')
  if (receiptId.startsWith('assistant_action_')) return undoApproval(caller, receiptId)
  const result = await db.transaction(async (tx) => {
    const [receiptRow] = await tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.id, receiptId as never), eq(auditLog.eventType, 'settings.applied')))
      .limit(1)
    const receipt = (receiptRow?.metadata as { receipt?: SettingsApplyReceipt } | null)?.receipt
    if (!receiptRow || !receipt)
      throw new NotFoundError('SETTINGS_RECEIPT_NOT_FOUND', 'Settings receipt not found')
    const entry = getSettingsArea(receiptRow.targetId ?? '')
    caller.assertAreaScope?.(entry.id)
    // Serialise undo and apply on the one settings row.
    await tx.select({ id: settings.id }).from(settings).limit(1).for('update')
    const [already] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.eventType, 'settings.undone'), eq(auditLog.targetId, receiptId)))
      .limit(1)
    if (already)
      throw new ConflictError('SETTINGS_UNDO_UNAVAILABLE', 'This change was already undone')
    try {
      await entry.undo(tx, actor, receipt)
    } catch (error) {
      if ((error as { code?: string }).code === 'SETTINGS_UNDO_CONFLICT')
        throw new ConflictError('SETTINGS_UNDO_CONFLICT', (error as Error).message)
      throw error
    }
    await recordAuditEventInTransaction(tx, {
      event: 'settings.undone',
      actor: await auditActor(tx, actor),
      target: { type: 'settings_receipt', id: receiptId },
      before: receipt.changes.map((change) => ({ id: change.id, value: change.after })),
      after: receipt.changes.map((change) => ({ id: change.id, value: change.before })),
      metadata: { area: receiptRow.targetId, principalId: actor.principalId },
    })
    return entry.id
  })
  await invalidateSettingsCache()
  return {
    status: 'undone',
    result: { id: receiptId, area: result, undone: true, undoneAt: new Date().toISOString() },
  }
}

async function undoApproval(caller: SettingsCaller, id: string): Promise<UndoSettingsOutcome> {
  const { actor } = caller
  const [row] = await db
    .select()
    .from(assistantPendingActions)
    .where(eq(assistantPendingActions.id, id as never))
    .limit(1)
  const receipt = row?.result as unknown as SettingsApplyReceipt | null
  if (!row || row.toolName !== 'propose_settings_change' || !receipt?.changes)
    throw new NotFoundError('SETTINGS_RECEIPT_NOT_FOUND', 'Settings receipt not found')
  if (row.status !== 'executed' || (row.result as { undoneAt?: string }).undoneAt)
    throw new ConflictError('SETTINGS_UNDO_UNAVAILABLE', 'This change cannot be undone')
  const areas = [...new Set(receipt.changes.map((change) => change.area))]
  for (const area of areas) {
    caller.assertAreaScope?.(area)
    await requireAreaPermission(actor, area, db)
  }

  if (!caller.signedInSession && settingsProposalRisk(receipt) !== 'low') {
    // The inverse: each changed value goes back to what it was.
    const patches = new Map<SettingsArea, Record<string, unknown>>()
    for (const change of receipt.changes) {
      const patch = patches.get(change.area) ?? {}
      let target = patch
      for (const key of change.path.slice(0, -1))
        target = (target[key] ??= {}) as Record<string, unknown>
      target[change.path.at(-1)!] = change.before
      patches.set(change.area, patch)
    }
    const inputs = [...patches].map(([area, patch]) => {
      parseAreaPatch(getSettingsArea(area), patch)
      return { area, patch }
    })
    const action = await enqueueWorkspaceSettingsProposal(
      actor,
      inputs,
      undefined,
      undefined,
      caller.requester
    )
    return { status: 'approval_required', approval: filedApproval(action) }
  }

  const undone = await undoWorkspaceSettingsProposal(actor, id as never, 'settings.undone')
  return {
    status: 'undone',
    result: {
      id,
      area: areas.length === 1 ? areas[0] : null,
      undone: true,
      undoneAt: String((undone.result as { undoneAt?: string } | null)?.undoneAt),
    },
  }
}
