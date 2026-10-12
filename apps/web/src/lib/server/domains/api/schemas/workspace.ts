/**
 * Workspace helper endpoints: @-mention lookups (signed-in session) and the
 * usage report (operator token).
 *
 * The mention endpoints answer with a bare JSON body rather than the `data`
 * envelope the key-authenticated endpoints use.
 */
import 'zod-openapi'
import { z } from 'zod'
import { registerPath, TypeIdSchema } from '../openapi'
import { TimestampSchema } from './common'

// Either cookie name, depending on whether the deployment serves HTTPS.
const sessionSecurity: Array<Record<string, string[]>> = [
  { sessionCookie: [] },
  { sessionCookieHttp: [] },
]

const MentionSuggestionSchema = z.object({
  principalId: TypeIdSchema,
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: z.enum(['admin', 'member', 'user']),
})

const PrincipalCardSchema = z.object({
  principalId: TypeIdSchema,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  role: z.string(),
  joinedAt: TimestampSchema,
})

const UsageSchema = z.object({
  aiTokensThisMonth: z.number().int(),
  postCount: z.number().int().meta({ description: 'Posts that are not deleted' }),
  boardCount: z.number().int().meta({ description: 'Boards that are not deleted' }),
  teamSeatCount: z.number().int(),
  pendingInviteCount: z.number().int(),
})

const sessionForbidden = {
  description: 'No signed-in session, or the session belongs to an anonymous or service principal',
  content: {
    'application/json': { schema: z.object({ error: z.literal('Forbidden') }) },
  },
}

registerPath('/mentions/suggest', {
  get: {
    tags: ['Workspace'],
    summary: 'Suggest people to @-mention',
    description:
      'Typeahead for mentions, matching the start of the display name. An empty query returns the first page of people. Returns at most 10 results and never exposes email addresses. Authenticated by the signed-in session cookie, not an API key. Limited to 60 requests per minute per session.',
    security: sessionSecurity,
    parameters: [
      {
        name: 'q',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'Start of the display name',
      },
      {
        name: 'scope',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['team'] },
        description: 'Set to team to return teammates only',
      },
    ],
    responses: {
      200: {
        description: 'Matching people',
        content: { 'application/json': { schema: z.array(MentionSuggestionSchema) } },
      },
      403: sessionForbidden,
      429: {
        description: 'More than 60 requests in a minute',
        content: {
          'application/json': { schema: z.object({ error: z.literal('Too Many Requests') }) },
        },
      },
    },
  },
})

registerPath('/users/{principalId}/card', {
  get: {
    tags: ['Workspace'],
    summary: 'Get a mention hover card',
    description:
      'Small profile payload for an @-mention chip: name, avatar, role and join date, with no email. Authenticated by the signed-in session cookie, not an API key.',
    security: sessionSecurity,
    parameters: [
      {
        name: 'principalId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'Principal ID',
      },
    ],
    responses: {
      200: {
        description: 'Profile card',
        content: { 'application/json': { schema: PrincipalCardSchema } },
      },
      403: sessionForbidden,
      404: {
        description: 'Principal not found',
        content: {
          'application/json': { schema: z.object({ error: z.literal('Not Found') }) },
        },
      },
    },
  },
})

registerPath('/admin/usage', {
  get: {
    tags: ['Workspace'],
    summary: 'Get workspace usage counters',
    description:
      'Usage counters for external billing meters. Authenticated with the operator token set in the ADMIN_API_TOKEN environment variable, sent as a bearer token; API keys are not accepted. Responds 404 when that variable is not set.',
    security: [{ adminToken: [] }],
    responses: {
      200: {
        description: 'Usage counters',
        content: { 'application/json': { schema: UsageSchema } },
      },
      401: {
        description: 'Missing or wrong operator token',
        content: {
          'application/json': { schema: z.object({ error: z.literal('unauthenticated') }) },
        },
      },
      404: { description: 'Operator token is not configured' },
    },
  },
})
