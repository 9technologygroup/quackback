/**
 * The person's side of a device sign-in (RFC 8628).
 *
 * A headless client (a CLI, an MCP client on a server) asked for a code and is
 * polling the token endpoint. The person opens `/device`, signs in, and sees
 * the code and the client's name. These functions look the code up and settle
 * it: approve (with the same capability choices the browser consent offers,
 * never wider than the client asked for) or deny.
 *
 * Better Auth owns the code: it binds a pending code to the first signed-in
 * person who looks it up and refuses anyone else after, which is what keeps a
 * guessed code from being approved by the wrong account. This file adds what
 * the endpoints lack in process: a per-person rate limit on lookups and an
 * audit trail.
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { requireAuth } from './auth-helpers'
import { hasRecentSignIn } from '@/lib/server/auth/recent-sign-in'
import {
  RecentSignInRequiredError,
  toRecentSignInRefusal,
  type RecentSignInRefusal,
} from '@/lib/shared/recent-sign-in'
import { logger } from '@/lib/server/logger'
import {
  deviceGrantHasCapability,
  deviceGrantScope,
  deviceRequestedCapabilities,
} from '@/lib/shared/device-grant-scopes'

const log = logger.child({ component: 'device-auth' })

const LOOKUPS_PER_MINUTE = 20

const codeSchema = z.object({ userCode: z.string().trim().min(1).max(32) })
const decisionSchema = codeSchema.extend({
  accept: z.boolean(),
  selectedScopes: z.array(z.string().max(64)).max(32).default([]),
  offlineAccess: z.boolean().default(false),
})

export type DeviceCodeLookup =
  | { state: 'invalid' }
  | { state: 'expired' }
  | { state: 'rate_limited' }
  /** Another account already opened this code. */
  | { state: 'unavailable' }
  | { state: 'settled'; status: 'approved' | 'denied' }
  | {
      state: 'ready'
      userCode: string
      clientName: string | null
      clientUri: string | null
      requestedScope: string
    }

/** What Better Auth's default alphabet accepts: letters and digits, upper case. */
function normalizeUserCode(userCode: string): string {
  return userCode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
}

/** True when this person has used up the minute's lookups. */
async function overLookupLimit(userId: string): Promise<boolean> {
  const { incrementBucket } = await import('@/lib/server/utils/rate-bucket')
  const { count } = await incrementBucket({ key: `device:lookup:${userId}`, windowSeconds: 60 })
  return count !== null && count > LOOKUPS_PER_MINUTE
}

/**
 * Why a settle was refused. Returned rather than thrown: an error thrown from a
 * server function does not reach the page with anything it can branch on.
 */
export type DeviceDecisionRefusal =
  'invalid' | 'expired' | 'unavailable' | 'no_scopes' | 'rate_limited'

export type DeviceDecision =
  | { ok: true; status: 'approved' | 'denied' }
  | { ok: false; reason: DeviceDecisionRefusal }
  | RecentSignInRefusal

interface VerifyResult {
  status: 'pending' | 'approved' | 'denied'
  client_id?: string
  scope?: string
}

/** Better Auth's lookup, mapped to this page's states. Binds a pending code to the caller. */
async function verifyCode(userCode: string): Promise<VerifyResult | 'invalid' | 'expired'> {
  const { getAuth } = await import('@/lib/server/auth')
  const auth = await getAuth()
  try {
    return (await auth.api.deviceVerify({
      query: { user_code: userCode },
      headers: getRequestHeaders(),
    })) as VerifyResult
  } catch (error) {
    const code = (error as { body?: { error?: string } }).body?.error
    if (code === 'expired_token') return 'expired'
    if (code === 'invalid_request') return 'invalid'
    throw error
  }
}

async function clientDetails(clientId: string) {
  const { db, oauthClient, eq } = await import('@/lib/server/db')
  const row = await db.query.oauthClient.findFirst({
    where: eq(oauthClient.clientId, clientId),
    columns: { name: true, uri: true },
  })
  return {
    clientName: row?.name ?? null,
    clientUri: row?.uri ?? null,
  }
}

/**
 * Looks a user code up for the signed-in person. The first person to look up a
 * pending code is the only one who may settle it.
 */
export const lookupDeviceCodeFn = createServerFn({ method: 'POST' })
  .validator(codeSchema)
  .handler(async ({ data }): Promise<DeviceCodeLookup> => {
    const ctx = await requireAuth()
    if (await overLookupLimit(ctx.user.id)) return { state: 'rate_limited' }

    const found = await verifyCode(data.userCode)
    if (found === 'invalid' || found === 'expired') return { state: found }
    if (found.status !== 'pending') return { state: 'settled', status: found.status }
    if (!found.client_id) return { state: 'unavailable' }

    return {
      state: 'ready',
      userCode: normalizeUserCode(data.userCode),
      ...(await clientDetails(found.client_id)),
      requestedScope: found.scope ?? '',
    }
  })

/** Approves (within what the client asked for) or denies a code the person has opened. */
export const decideDeviceCodeFn = createServerFn({ method: 'POST' })
  .validator(decisionSchema)
  .handler(async ({ data }): Promise<DeviceDecision> => {
    const ctx = await requireAuth()
    // Approving hands a client long-lived access as this person, so it needs a
    // sign-in from the last few minutes. Denying never does. Returned as a
    // value: a thrown error would reach the page without its code.
    if (data.accept && !(await hasRecentSignIn(ctx))) {
      return toRecentSignInRefusal(new RecentSignInRequiredError())!
    }
    if (await overLookupLimit(ctx.user.id)) return { ok: false, reason: 'rate_limited' }

    const found = await verifyCode(data.userCode)
    if (found === 'invalid' || found === 'expired') return { ok: false, reason: found }
    if (found.status !== 'pending' || !found.client_id) return { ok: false, reason: 'unavailable' }

    const { getAuth } = await import('@/lib/server/auth')
    const auth = await getAuth()
    const headers = getRequestHeaders()
    const userCode = normalizeUserCode(data.userCode)
    const { recordAuditEvent, actorFromAuth } = await import('@/lib/server/audit/log')

    if (!data.accept) {
      await auth.api.deviceDeny({ body: { userCode }, headers })
      await recordAuditEvent({
        event: 'oauth.device.denied',
        actor: actorFromAuth(ctx),
        headers,
        target: { type: 'oauth_client', id: found.client_id },
      })
      return { ok: true, status: 'denied' }
    }

    // Narrow to what was asked: the page already disables anything wider, so
    // this is the server holding the same line against a hand-made request.
    const grant = deviceGrantScope({
      requestedScope: found.scope,
      selected: data.selectedScopes,
      offlineAccess: data.offlineAccess,
    })
    if (deviceRequestedCapabilities(found.scope).length > 0 && !deviceGrantHasCapability(grant)) {
      return { ok: false, reason: 'no_scopes' }
    }

    // The scope the token will carry is the one stored on the code, so settle
    // it before approving. Guarded on the claimant and on `pending` so it can
    // only ever narrow a code this person opened and has not yet settled.
    const { db, deviceCode, and, eq } = await import('@/lib/server/db')
    const narrowed = await db
      .update(deviceCode)
      .set({ scope: grant })
      .where(
        and(
          eq(deviceCode.userCode, userCode),
          eq(deviceCode.userId, ctx.user.id),
          eq(deviceCode.status, 'pending')
        )
      )
      .returning({ id: deviceCode.id })
    if (narrowed.length === 0) return { ok: false, reason: 'unavailable' }

    await auth.api.deviceApprove({ body: { userCode }, headers })
    await recordAuditEvent({
      event: 'oauth.device.approved',
      actor: actorFromAuth(ctx),
      headers,
      target: { type: 'oauth_client', id: found.client_id },
      metadata: { scope: grant },
    })
    log.info({ user_id: ctx.user.id, client_id: found.client_id }, 'device sign-in approved')
    return { ok: true, status: 'approved' }
  })
