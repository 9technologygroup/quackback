/**
 * Segments API Schema Registrations
 */
import 'zod-openapi'
import { z } from 'zod'
import {
  registerPath,
  TypeIdSchema,
  createItemResponseSchema,
  createRequestBodySchema,
  asSchema,
} from '../openapi'
import { errorResponses } from './errors'

const MembersBodySchema = createRequestBodySchema({
  principalIds: z.array(TypeIdSchema).min(1).max(1000).meta({
    description:
      'Principals to add or remove. Only human user principals qualify; unknown, anonymous and service principals are reported in failed.',
  }),
})

const failed = z.array(z.string()).meta({
  description: 'Principal IDs that did not resolve or whose update failed',
})

const slugParam = {
  name: 'slug',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'Segment slug',
} as const

registerPath('/segments/{slug}/members', {
  post: {
    tags: ['Segments'],
    summary: 'Add users to a segment',
    description:
      'Adds users to the segment as API-sourced members. A manual assignment is never demoted. Requires the segment.manage permission.',
    parameters: [slugParam],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: asSchema(MembersBodySchema) } },
    },
    responses: {
      200: {
        description: 'Membership result',
        content: {
          'application/json': {
            schema: createItemResponseSchema(
              z.object({ added: z.number().int(), failed }),
              'Add result'
            ),
          },
        },
      },
      ...errorResponses(400, 403, 404),
    },
  },
  delete: {
    tags: ['Segments'],
    summary: 'Remove users from a segment',
    description:
      'Removes users from the segment. The body carries the principal IDs. Requires the segment.manage permission.',
    parameters: [slugParam],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: asSchema(MembersBodySchema) } },
    },
    responses: {
      200: {
        description: 'Membership result',
        content: {
          'application/json': {
            schema: createItemResponseSchema(
              z.object({ removed: z.number().int(), failed }),
              'Remove result'
            ),
          },
        },
      },
      ...errorResponses(400, 403, 404),
    },
  },
})
