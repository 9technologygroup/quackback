/**
 * The approvals queue: the requests a viewer may decide, across
 * conversations, tickets, Home threads and requests with no parent, and one
 * request with its diff. The reads behind the Approvals page and the REST and
 * MCP approval reads.
 *
 * The parent each row hangs off is scoped in SQL by the same rule a decision
 * checks for that one item; whether the viewer holds every permission the operation
 * needs is read per row from the operation itself. A decision checks all of
 * it again, so the queue only decides what is shown, never what is allowed.
 */
import {
  db,
  and,
  or,
  eq,
  gt,
  desc,
  exists,
  isNull,
  isNotNull,
  tickets,
  assistantPendingActions,
  type ApprovalDecisionChannel,
  type ApprovalRequestChannel,
  type ApprovalRisk,
} from '@/lib/server/db'
import type { AssistantPendingActionId } from '@quackback/ids'
import { ticketFilter } from '@/lib/server/policy/tickets'
import { can } from '@/lib/server/policy/authorize'
import { isTeamActor, type Actor } from '@/lib/server/policy/types'
import { PERMISSIONS, type PermissionKey } from '@/lib/shared/permissions'
import type { JsonValue } from '@/lib/shared/json'
import { settingsProposalSchema } from '@/lib/shared/assistant/settings-proposals'
import { SETTINGS_PROPOSAL_TOOL } from './approval-policy'
import {
  digestForDisplay,
  approvalNotFound,
  approvalRiskOf,
  isDecidableApproval,
  requiredApprovalPermissions,
} from './approvals.service'

type PendingActionRow = typeof assistantPendingActions.$inferSelect

/** What changes, as the person deciding reads it. */
export type ApprovalDiff =
  | {
      kind: 'settings'
      changes: Array<{
        id: string
        area: string
        path: string[]
        before: JsonValue
        after: JsonValue
      }>
    }
  | { kind: 'action'; args: JsonValue }

/** One request, as the queue and its reads show it. */
export interface ApprovalView {
  id: string
  toolName: string
  /** Written by the server from the diff. */
  summary: string
  risk: ApprovalRisk
  status: string
  parent: { kind: 'conversation' | 'ticket' | 'thread' | 'none'; id: string | null }
  requestedVia: ApprovalRequestChannel | null
  requestedById: string | null
  onBehalfOfPrincipalId: string | null
  clientName: string | null
  proposedAt: string
  expiresAt: string
  /** The digest a decision on this request must name. */
  contentHash: string
  /** Approving needs an admin who signed in again; turning it down needs only an admin. */
  needsFreshSignIn: boolean
  /** The viewer may decide it now. */
  canDecide: boolean
  decidedById: string | null
  decidedAt: string | null
  decidedVia: ApprovalDecisionChannel | null
  decisionReason: string | null
  diff: ApprovalDiff
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
/** Rows read per page before the per-row permission filter. */
const SCAN_LIMIT = 200

function diffOf(row: PendingActionRow): ApprovalDiff {
  if (row.toolName === SETTINGS_PROPOSAL_TOOL) {
    const parsed = settingsProposalSchema.safeParse(row.args)
    if (parsed.success)
      return {
        kind: 'settings',
        changes: parsed.data.changes.map((change) => ({
          id: change.id,
          area: change.area,
          path: change.path,
          before: change.before as JsonValue,
          after: change.after as JsonValue,
        })),
      }
  }
  return { kind: 'action', args: row.args as JsonValue }
}

function parentOf(row: PendingActionRow): ApprovalView['parent'] {
  if (row.conversationId) return { kind: 'conversation', id: row.conversationId }
  if (row.ticketId) return { kind: 'ticket', id: row.ticketId }
  if (row.workspaceThreadKey) return { kind: 'thread', id: null }
  return { kind: 'none', id: null }
}

function holdsAll(actor: Actor, required: ReadonlySet<PermissionKey>): boolean {
  return [...required].every((permission) => can(actor, permission))
}

/** Whether this viewer could decide this request, setting aside a fresh sign-in. */
function mayDecide(row: PendingActionRow, actor: Actor, required: ReadonlySet<PermissionKey>) {
  const risk = approvalRiskOf(row)
  return (
    row.status === 'proposed' &&
    row.expiresAt.getTime() > Date.now() &&
    row.requestedById !== actor.principalId &&
    risk !== 'critical' &&
    (risk !== 'high' || actor.role === 'admin') &&
    holdsAll(actor, required)
  )
}

/** A request as shown; showing one stores the digest a decision on it must name. */
async function toView(row: PendingActionRow, canDecide: boolean): Promise<ApprovalView> {
  const risk = approvalRiskOf(row)
  return {
    id: row.id,
    toolName: row.toolName,
    summary: row.summary,
    risk,
    status: row.status,
    parent: parentOf(row),
    requestedVia: row.requestedVia,
    requestedById: row.requestedById,
    onBehalfOfPrincipalId: row.onBehalfOfPrincipalId,
    clientName: row.clientName,
    proposedAt: row.proposedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    contentHash: await digestForDisplay(row),
    needsFreshSignIn: risk === 'high',
    canDecide,
    decidedById: row.decidedById,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedVia: row.decidedVia,
    decisionReason: row.decisionReason,
    diff: diffOf(row),
  }
}

/**
 * Rows whose parent this viewer may see, by the same rule a decision checks
 * for one item, so everyone a request is brought to can find it here. A
 * conversation is visible to any teammate who may view conversations
 * (`canViewConversation`), assigned or not; a ticket by `ticketFilter`, as
 * `assertTicketVisible` reads it. A request with no item is left to the
 * permission check.
 */
function parentVisible(actor: Actor) {
  return or(
    and(isNull(assistantPendingActions.conversationId), isNull(assistantPendingActions.ticketId)),
    can(actor, PERMISSIONS.CONVERSATION_VIEW)
      ? isNotNull(assistantPendingActions.conversationId)
      : undefined,
    exists(
      db
        .select({ id: tickets.id })
        .from(tickets)
        .where(and(eq(tickets.id, assistantPendingActions.ticketId), ticketFilter(actor)))
    )
  )
}

/** Only teammates decide: a person, never a credential, agent or portal user. */
function isTeammate(actor: Actor): boolean {
  return actor.principalType === 'user' && !!actor.principalId && isTeamActor(actor)
}

/**
 * The pending requests this viewer may decide, newest first. Only people
 * decide, so a credential or agent sees an empty queue.
 */
export async function listApprovalsForViewer(
  actor: Actor,
  options: { limit?: number } = {}
): Promise<ApprovalView[]> {
  if (!isTeammate(actor)) return []
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
  const rows = await db
    .select()
    .from(assistantPendingActions)
    .where(
      and(
        eq(assistantPendingActions.status, 'proposed'),
        gt(assistantPendingActions.expiresAt, new Date()),
        parentVisible(actor)
      )
    )
    .orderBy(desc(assistantPendingActions.proposedAt))
    .limit(SCAN_LIMIT)
  const views: ApprovalView[] = []
  const requirements = new Map<string, Promise<ReadonlySet<PermissionKey> | null>>()
  for (const row of rows) {
    if (views.length >= limit) break
    if (!isDecidableApproval(row)) continue
    // Settings requests differ per row; a tool's needs are the same for every row of it.
    const key = row.toolName === SETTINGS_PROPOSAL_TOOL ? row.id : row.toolName
    if (!requirements.has(key)) requirements.set(key, requiredApprovalPermissions(row))
    const required = await requirements.get(key)!
    if (required && mayDecide(row, actor, required)) views.push(await toView(row, true))
  }
  return views
}

/**
 * One request with its diff, for a viewer who may decide it or on whose
 * behalf it was filed. Anything else reads as not found, the same as a
 * request that does not exist.
 */
export async function getApprovalForViewer(
  actor: Actor,
  id: AssistantPendingActionId
): Promise<ApprovalView> {
  if (!isTeammate(actor)) throw approvalNotFound()
  const [row] = await db
    .select()
    .from(assistantPendingActions)
    .where(and(eq(assistantPendingActions.id, id), parentVisible(actor)))
    .limit(1)
  if (!row || !isDecidableApproval(row)) throw approvalNotFound()
  const required = await requiredApprovalPermissions(row)
  const qualified = !!required && holdsAll(actor, required)
  if (!qualified && row.onBehalfOfPrincipalId !== actor.principalId) throw approvalNotFound()
  return toView(row, !!required && mayDecide(row, actor, required))
}
