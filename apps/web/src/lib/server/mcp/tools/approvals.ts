/**
 * Approval reads: an assistant follows the requests it filed (and those the
 * person it acts for could decide) without a browser. Nothing here decides a
 * request. A person decides it in the app, at the url each result carries.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AssistantPendingActionId } from '@quackback/ids'
import { ForbiddenError, ValidationError } from '@/lib/shared/errors'
import {
  APPROVAL_STATUSES,
  approvalIdFromReference,
  type ApprovalStatus,
} from '@/lib/shared/assistant/approvals'
import type { Actor } from '@/lib/server/policy/types'
import type { ApprovalFollower } from '@/lib/server/domains/assistant/approvals.follow'
import { resolveMcpActor } from '../resolve-actor'
import type { McpAuthContext } from '../types'
import { registerTool, jsonResult, compactJsonResult, READ_ONLY } from './helpers'

/**
 * What this session follows: the requests its credential filed (for an
 * assistant client, only those of the person signed in), and those the person
 * it acts for could decide with this session's scopes and role. A key's role
 * is its own, which stays a member's when its creator is later made an admin.
 */
async function followerFor(auth: McpAuthContext): Promise<ApprovalFollower> {
  const { narrowToCredential } = await import('@/lib/server/domains/assistant/approvals.follow')
  let decider: Actor | null = null
  try {
    decider = narrowToCredential(await resolveMcpActor(auth, 'read:settings'), {
      scopes: auth.scopes,
      role: auth.role,
    })
  } catch (err) {
    // A key whose creator left the team still follows what it filed.
    if (!(err instanceof ForbiddenError)) throw err
  }
  return {
    filed: auth.credentialId
      ? {
          credentialId: auth.credentialId,
          ...(auth.authMethod === 'oauth' ? { onBehalfOfPrincipalId: auth.principalId } : {}),
        }
      : null,
    decider,
  }
}

export function registerApprovalTools(server: McpServer, auth: McpAuthContext) {
  registerTool<{ approval: string }>(server, auth, {
    name: 'get_approval',
    description: `Check where an approval request stands: pending, approved, rejected, expired, superseded, applied, undone (applied, then reverted by a person in the app; see undoneAt) or failed. Pass the approvalId or the url that propose_settings_change returned. Returns the risk, a title and summary written by the server, each change (field, from, to), who asked, who decided and why, when it was undone, and the url where a person decides it. You cannot approve or reject anything with this tool; only a person can, in the app.
Examples:
{"approval":"assistant_action_01h455vb4pex5vsknk084sn02q"}
{"approval":"https://feedback.example.com/admin/approvals?id=assistant_action_01h455vb4pex5vsknk084sn02q"}`,
    schema: {
      approval: z
        .string()
        .min(1)
        .max(2048)
        .describe('The approval id (assistant_action_...) or its url'),
    },
    annotations: READ_ONLY,
    scope: 'read:settings',
    teamOnly: true,
    // Each approval is checked against the follower's permissions row by row.
    permissions: 'none',
    handler: async ({ approval }) => {
      const id = approvalIdFromReference(approval)
      if (!id)
        throw new ValidationError(
          'VALIDATION_ERROR',
          'Pass an approval id (assistant_action_...) or the approval url.'
        )
      const { getApprovalForFollower } =
        await import('@/lib/server/domains/assistant/approvals.follow')
      return jsonResult(
        await getApprovalForFollower(await followerFor(auth), id as AssistantPendingActionId)
      )
    },
  })

  registerTool<{ status?: ApprovalStatus; cursor?: string; limit?: number }>(server, auth, {
    name: 'list_approvals',
    description: `List the approval requests you follow, newest first: the ones you filed, and the ones the person you act for could decide. Filter by status; page with cursor. A page can hold fewer items than limit while hasMore is true; keep paging with nextCursor. Each item carries the url where a person decides it. You cannot approve or reject anything with this tool; only a person can, in the app.
Examples:
{"status":"pending"}
{"status":"rejected","limit":10}`,
    schema: {
      status: z.enum(APPROVAL_STATUSES).optional().describe('Only approvals in this state'),
      cursor: z.string().optional().describe('nextCursor from a previous response'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
    },
    annotations: READ_ONLY,
    scope: 'read:settings',
    teamOnly: true,
    // Each approval is checked against the follower's permissions row by row.
    permissions: 'none',
    handler: async ({ status, cursor, limit }) => {
      const after = cursor === undefined ? undefined : approvalIdFromReference(cursor)
      if (after === null)
        throw new ValidationError('VALIDATION_ERROR', 'Pass the nextCursor from a previous page.')
      const { listApprovalsForFollower } =
        await import('@/lib/server/domains/assistant/approvals.follow')
      const page = await listApprovalsForFollower(await followerFor(auth), {
        status,
        limit,
        cursor: after as AssistantPendingActionId | undefined,
      })
      return compactJsonResult({
        approvals: page.items,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      })
    },
  })
}
