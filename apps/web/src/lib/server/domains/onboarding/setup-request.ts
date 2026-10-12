/**
 * `POST /api/v1/setup`: the HTTP face of {@link runHeadlessSetup}.
 *
 * Order matters. The rate limit comes first so a guessing run is throttled
 * before it costs a database read; the token comes next so nobody without it
 * learns anything about the install's state; and only a caller holding the
 * token is told the install is already set up (409).
 */
import { getClientIp } from '@/lib/server/domains/api/rate-limit'
import {
  badRequestResponse,
  createdResponse,
  errorResponse,
  handleDomainError,
  notFoundResponse,
  rateLimitedResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from '@/lib/server/domains/api/responses'
import { recordAuditEvent } from '@/lib/server/audit/log'
import {
  bucketRetryAfter,
  getBucketCount,
  incrementBucket,
  incrementBuckets,
} from '@/lib/server/utils/rate-bucket'
import { config } from '@/lib/server/config'
import { logger } from '@/lib/server/logger'
import {
  headlessSetupSchema,
  isAwaitingFirstAdmin,
  runHeadlessSetup,
  verifySetupToken,
} from '@/lib/server/domains/onboarding/headless-setup'

const log = logger.child({ component: 'headless-setup' })

const WINDOW_SECONDS = 60
/** Attempts per address per window, whatever their outcome. */
const MAX_PER_ADDRESS = 10
/** Failed attempts from everywhere per window: a spread-out guessing run still meets a ceiling. */
const MAX_FAILURES_OVERALL = 60

const ADDRESS_BUCKET = (ip: string) => ({ key: `setup:rl:ip:${ip}`, windowSeconds: WINDOW_SECONDS })
const OVERALL_FAILURES_BUCKET = { key: 'setup:rl:all', windowSeconds: WINDOW_SECONDS }

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim() || null
}

/**
 * Every attempt counts against its address; only failed ones count against the
 * overall budget, so a flood of valid-looking noise from elsewhere cannot lock
 * the operator out of their own install.
 */
async function throttled(ip: string): Promise<number | null> {
  const address = ADDRESS_BUCKET(ip)
  const [addressCount] = await incrementBuckets([address])
  if (addressCount !== null && addressCount > MAX_PER_ADDRESS) return bucketRetryAfter(address)
  if ((await getBucketCount(OVERALL_FAILURES_BUCKET.key)) > MAX_FAILURES_OVERALL) {
    return bucketRetryAfter(OVERALL_FAILURES_BUCKET)
  }
  return null
}

export async function handleSetupRequest(request: Request): Promise<Response> {
  try {
    const retryAfter = await throttled(getClientIp(request))
    if (retryAfter !== null) return rateLimitedResponse(retryAfter)

    // The endpoint exists only on an install that is waiting for its first
    // admin and is not a control plane's. Anywhere else it is not there, for
    // every caller and without a trace, so nothing about the install's state
    // can be read from it.
    if (config.isPooledTenancy || !(await isAwaitingFirstAdmin())) {
      return notFoundResponse('Endpoint')
    }

    const presented = bearerToken(request)
    const check = presented ? await verifySetupToken(presented) : null
    // With no token configured the endpoint does not exist, whatever was sent.
    if (check === 'not_configured') return notFoundResponse('Endpoint')
    if (check !== 'ok') {
      await incrementBucket(OVERALL_FAILURES_BUCKET)
      log.warn('setup request refused: missing or wrong setup token')
      await recordAuditEvent({
        event: 'workspace.setup.rejected',
        outcome: 'failure',
        actor: { type: 'anonymous' },
        headers: request.headers,
        metadata: { reason: presented ? 'wrong_token' : 'missing_token' },
      })
      return unauthorizedResponse('A valid setup token is required')
    }

    let json: unknown
    try {
      json = await request.json()
    } catch {
      return badRequestResponse('Request body must be JSON')
    }
    const parsed = headlessSetupSchema.safeParse(json)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error.issues[0]?.message ?? 'Invalid request body', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }

    const result = await runHeadlessSetup(parsed.data, request.headers)
    if (!result.ok) {
      await recordAuditEvent({
        event: 'workspace.setup.rejected',
        outcome: 'failure',
        actor: { type: 'anonymous' },
        headers: request.headers,
        metadata: { reason: result.reason },
      })
      if (result.reason === 'account_unverified') {
        return errorResponse(
          'SETUP_ACCOUNT_UNVERIFIED',
          'An unverified account already uses this adminEmail. Use a different address, or sign in to that account in the browser and verify it first.',
          409
        )
      }
      return errorResponse(
        'SETUP_ALREADY_COMPLETE',
        'This workspace already has an admin, so the setup token no longer opens anything.',
        409
      )
    }
    return createdResponse({
      workspace: result.workspace,
      admin: result.admin,
      apiKey: result.apiKey,
      reusedExistingAccount: result.reusedExistingAccount,
    })
  } catch (error) {
    return handleDomainError(error)
  }
}
