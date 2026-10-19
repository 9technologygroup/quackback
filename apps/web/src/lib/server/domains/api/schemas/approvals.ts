/**
 * Approvals API Schema Registrations
 *
 * Read-only: an approval is decided by a person in the app, never over the
 * API. Field names match the approval.requested, approval.decided and
 * approval.applied webhook payloads where they overlap.
 */
import 'zod-openapi'
import { z } from 'zod'
import {
  registerPath,
  TypeIdSchema,
  createItemResponseSchema,
  createPaginatedResponseSchema,
} from '../openapi'
import {
  TimestampSchema,
  NullableTimestampSchema,
  UnauthorizedErrorSchema,
  NotFoundErrorSchema,
  ValidationErrorSchema,
} from './common'
import { APPROVAL_STATUSES } from '@/lib/shared/assistant/approvals'
import {
  APPROVAL_DECISION_CHANNELS,
  APPROVAL_REQUEST_CHANNELS,
  APPROVAL_RISKS,
} from '@/lib/shared/db-types'

const WHO_SEES_WHAT =
  "A key reads the requests it filed. It also reads the requests its creator could decide, judged with the creator's current permissions narrowed to the key's own role and scopes, so a creator who loses a permission takes those requests with them. Any other approval answers 404, the same as an id that does not exist. Requires the read:settings scope (write:settings includes it)."

const ApprovalChangeSchema = z
  .object({
    field: z
      .string()
      .meta({ description: 'The setting that changes', example: 'portal.displayName' }),
    from: z
      .unknown()
      .meta({ description: 'Its value when the request was filed', example: 'Acme' }),
    to: z
      .unknown()
      .meta({ description: 'The value the request proposes', example: 'Acme Support' }),
  })
  .meta({ description: 'One change a settings request makes' })

export const ApprovalSchema = z
  .object({
    id: TypeIdSchema.meta({ example: 'assistant_action_01h455vb4pex5vsknk084sn02q' }),
    status: z.enum(APPROVAL_STATUSES).meta({
      description:
        'pending waits for a person. approved and rejected are their decision. applied and failed say how an approved change ran. undone is an applied change a person later reverted in the app (see undoneAt). expired timed out before anyone decided. superseded was replaced by a newer request that combines it.',
      example: 'pending',
    }),
    risk: z.enum(APPROVAL_RISKS).meta({
      description: 'Set by the server for the operation. High needs an admin who signed in again.',
      example: 'low',
    }),
    toolName: z.string().meta({
      description: 'The operation requested',
      example: 'propose_settings_change',
    }),
    title: z.string().meta({
      description: 'What kind of request this is, written by the server',
      example: 'Settings change',
    }),
    summary: z.string().meta({
      description:
        'One line on what the request does, written by the server and never quoting a proposed value',
      example: 'Change the workspace name',
    }),
    changes: z.array(ApprovalChangeSchema).meta({
      description:
        'Each change a settings request makes. Empty for other requests; open url to review those.',
    }),
    conversationId: TypeIdSchema.nullable().meta({
      description: 'The conversation the request acts on, null if none',
      example: null,
    }),
    ticketId: TypeIdSchema.nullable().meta({
      description: 'The ticket the request acts on, null if none',
      example: null,
    }),
    requestedVia: z.enum(APPROVAL_REQUEST_CHANNELS).meta({
      description: 'How the request arrived',
      example: 'mcp',
    }),
    requestedById: TypeIdSchema.nullable().meta({
      description:
        "The principal that filed it: an API key's service principal, or null when a person's own client filed it",
      example: 'principal_01h455vb4pex5vsknk084sn02q',
    }),
    onBehalfOfPrincipalId: TypeIdSchema.nullable().meta({
      description: "The person whose authority the request borrows, such as the key's creator",
      example: 'principal_01h455vb4pex5vsknk084sn03r',
    }),
    clientName: z.string().nullable().meta({
      description: 'The name of the API key the request came through, null otherwise',
      example: 'Deploy bot',
    }),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema.meta({
      description: 'When a pending request expires if nobody decides it',
    }),
    decidedById: TypeIdSchema.nullable().meta({
      description: 'The person who approved or rejected it, null until then',
      example: null,
    }),
    decidedAt: NullableTimestampSchema.meta({
      description: 'When it was decided, null until then',
    }),
    decidedVia: z.enum(APPROVAL_DECISION_CHANNELS).nullable().meta({
      description: 'Where the person decided it, null until then',
      example: null,
    }),
    reason: z.string().nullable().meta({
      description: 'Why the person rejected it, when they said',
      example: null,
    }),
    undoneAt: NullableTimestampSchema.meta({
      description: 'When a person undid the applied change, null unless status is undone',
    }),
    url: z.string().meta({
      description: 'The page in the app where a person reviews and decides this request',
      example:
        'https://feedback.example.com/admin/approvals?id=assistant_action_01h455vb4pex5vsknk084sn02q',
    }),
  })
  .meta({ description: 'A request for a person to approve a change' })

const ForbiddenScopeErrorSchema = z
  .object({
    error: z.object({
      code: z.literal('FORBIDDEN'),
      message: z.string(),
    }),
  })
  .meta({ description: 'The API key lacks the read:settings scope' })

const commonErrors = {
  401: {
    description: 'Unauthorized',
    content: { 'application/json': { schema: UnauthorizedErrorSchema } },
  },
  403: {
    description: 'The API key lacks the read:settings scope',
    content: { 'application/json': { schema: ForbiddenScopeErrorSchema } },
  },
}

registerPath('/approvals', {
  get: {
    tags: ['Approvals'],
    summary: 'List approvals',
    description: `Returns the approvals this key follows, newest first. ${WHO_SEES_WHAT} One call reads a bounded number of requests, so a page can hold fewer items than limit, even none, while meta.pagination.hasMore is true; keep following the cursor. Nothing here decides an approval: a person decides it in the app, at its url.`,
    parameters: [
      {
        name: 'status',
        in: 'query',
        schema: { type: 'string', enum: [...APPROVAL_STATUSES] },
        description: 'Only approvals in this state',
      },
      {
        name: 'cursor',
        in: 'query',
        schema: { type: 'string' },
        description: 'Pagination cursor from the previous response (meta.pagination.cursor)',
      },
      {
        name: 'limit',
        in: 'query',
        schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
        description: 'Items per page (max 100)',
      },
    ],
    responses: {
      200: {
        description: 'Approvals',
        content: {
          'application/json': {
            schema: createPaginatedResponseSchema(ApprovalSchema, 'Approvals list'),
          },
        },
      },
      400: {
        description: 'Unknown status or malformed cursor',
        content: { 'application/json': { schema: ValidationErrorSchema } },
      },
      ...commonErrors,
    },
  },
})

registerPath('/approvals/{approvalId}', {
  get: {
    tags: ['Approvals'],
    summary: 'Get an approval',
    description: `Returns where one request stands, with the url a person opens to decide it. ${WHO_SEES_WHAT}`,
    parameters: [
      {
        name: 'approvalId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'Approval ID',
      },
    ],
    responses: {
      200: {
        description: 'Approval details',
        content: {
          'application/json': {
            schema: createItemResponseSchema(ApprovalSchema, 'Approval details'),
          },
        },
      },
      400: {
        description: 'Malformed approval ID',
        content: { 'application/json': { schema: ValidationErrorSchema } },
      },
      ...commonErrors,
      404: {
        description: 'No approval with this ID that the key may read',
        content: { 'application/json': { schema: NotFoundErrorSchema } },
      },
    },
  },
})
