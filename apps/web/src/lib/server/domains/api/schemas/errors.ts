/**
 * Shared error response schemas and a helper that builds the standard error
 * response map for an operation.
 */
import 'zod-openapi'
import { z } from 'zod'
import { UnauthorizedErrorSchema, NotFoundErrorSchema, ValidationErrorSchema } from './common'

export const ForbiddenErrorSchema = z
  .object({
    error: z.object({
      code: z.string().meta({ example: 'FORBIDDEN' }),
      message: z.string(),
    }),
  })
  .meta({ description: 'The API key lacks the permission this operation requires' })

export const ConflictErrorSchema = z
  .object({
    error: z.object({
      code: z.literal('CONFLICT'),
      message: z.string(),
    }),
  })
  .meta({ description: 'The request conflicts with the current state of the resource' })

export const RateLimitedErrorSchema = z
  .object({
    error: z.object({
      code: z.literal('RATE_LIMITED'),
      message: z.string(),
    }),
  })
  .meta({ description: 'Too many requests; see the Retry-After header' })

const ERROR_RESPONSES = {
  400: { description: 'Validation error', schema: ValidationErrorSchema },
  401: { description: 'Unauthorized', schema: UnauthorizedErrorSchema },
  403: { description: 'Forbidden', schema: ForbiddenErrorSchema },
  404: { description: 'Not found', schema: NotFoundErrorSchema },
  409: { description: 'Conflict', schema: ConflictErrorSchema },
  429: {
    description: 'Rate limited. The Retry-After header gives the seconds to wait.',
    schema: RateLimitedErrorSchema,
  },
} as const

type ErrorStatus = keyof typeof ERROR_RESPONSES

/**
 * Standard error responses for an operation. Always includes 401 and 429, which
 * every authenticated route can return; pass the other statuses the route uses.
 */
export function errorResponses(...statuses: ErrorStatus[]) {
  const all = [...new Set<ErrorStatus>([...statuses, 401, 429])].sort((a, b) => a - b)
  return Object.fromEntries(
    all.map((status) => {
      const { description, schema } = ERROR_RESPONSES[status]
      return [status, { description, content: { 'application/json': { schema } } }]
    })
  )
}
