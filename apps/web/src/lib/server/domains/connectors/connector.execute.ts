/**
 * The shared connector call executor: render -> auth -> rate-limit ->
 * safeFetch -> shape the response, plus the circuit breaker that persists
 * failure_count/status. Split out of connector.service.ts (CRUD) because the
 * two halves change for different reasons — this one for request/response
 * shaping, that one for validation and storage.
 */
import { db, eq, sql, dataConnectors } from '@/lib/server/db'
import type { DataConnectorId } from '@quackback/ids'
import type { JsonValue } from '@/lib/shared/json'
import { logger } from '@/lib/server/logger'
import { config } from '@/lib/server/config'
import { safeFetch, SsrfError, TimeoutError } from '@/lib/server/content/ssrf-guard'
import { incrementBucket } from '@/lib/server/utils/redis-rate-bucket'
import { renderTemplate } from './connector.render'
import { decryptConnectorSecret } from './connector.encryption'
import { getConnectorRowForExecution, type ConnectorRow } from './connector.service'
import type { ConnectorValues, ConnectorRuntimeContext, ConnectorExecutionResult, ConnectorAuthConfig } from './connector.types'

export { getConnectorRowForExecution }

const log = logger.child({ component: 'connectors' })

/** Consecutive-failure auto-disable threshold; mirrors the webhook circuit breaker. */
const MAX_FAILURES = 50
/** Per-connector calls-per-minute ceiling, keyed by connector id. */
const RATE_LIMIT_PER_MINUTE = 30
const RATE_LIMIT_WINDOW_SECONDS = 60
/** Response bodies (and the persisted example_response) are truncated to this many bytes. */
const RESPONSE_TRUNCATE_BYTES = 4096

function rateBucketKey(id: DataConnectorId): string {
  return `connector-rate:${id}`
}

function builtinValues(runtimeCtx: ConnectorRuntimeContext): ConnectorValues {
  const values: ConnectorValues = {}
  if (runtimeCtx.customerEmail != null) values['customer.email'] = runtimeCtx.customerEmail
  if (runtimeCtx.customerName != null) values['customer.name'] = runtimeCtx.customerName
  if (runtimeCtx.conversationId != null) values['conversation.id'] = runtimeCtx.conversationId
  return values
}

function buildAuthHeader(auth: ConnectorAuthConfig, secret: string): [string, string] | null {
  switch (auth.type) {
    case 'bearer':
      return ['Authorization', `Bearer ${secret}`]
    case 'header':
      // validateAuthConfig guarantees headerName is set whenever type is 'header'.
      return [auth.headerName as string, secret]
    case 'basic':
      return ['Authorization', `Basic ${Buffer.from(secret, 'utf8').toString('base64')}`]
    case 'none':
      return null
  }
}

/** Try to parse JSON; fall back to the raw text for a non-JSON response. */
function parseBody(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Resolve `paths` (dot notation) against `data`, keyed by the path itself. */
function pickPaths(data: unknown, paths: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const path of paths) {
    let cursor: unknown = data
    for (const segment of path.split('.')) {
      if (cursor === null || typeof cursor !== 'object') {
        cursor = undefined
        break
      }
      cursor = (cursor as Record<string, unknown>)[segment]
    }
    picked[path] = cursor ?? null
  }
  return picked
}

/** Truncate a response payload to a byte budget, degrading to a preview
 *  string rather than emitting invalid JSON or an oversized tool result. */
function truncateResponse(data: unknown, maxBytes = RESPONSE_TRUNCATE_BYTES): unknown {
  const serialized = typeof data === 'string' ? data : JSON.stringify(data)
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return data
  const preview = Buffer.from(serialized, 'utf8').subarray(0, maxBytes).toString('utf8')
  return typeof data === 'string' ? preview : { truncated: true, preview }
}

function isHostAllowed(hostname: string): boolean {
  const allowlist = config.connectorAllowedHosts
  if (!allowlist?.trim()) return true
  const hosts = allowlist
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  return hosts.includes(hostname.toLowerCase())
}

/** Increment the circuit breaker on a failed call, auto-disabling at the
 *  threshold — the same CASE-in-one-UPDATE shape as the webhook breaker in
 *  events/process.ts. */
async function recordFailure(id: DataConnectorId, message: string): Promise<void> {
  await db
    .update(dataConnectors)
    .set({
      failureCount: sql`${dataConnectors.failureCount} + 1`,
      lastError: message,
      status: sql`CASE WHEN ${dataConnectors.failureCount} + 1 >= ${MAX_FAILURES} THEN 'disabled' ELSE ${dataConnectors.status} END`,
      updatedAt: new Date(),
    })
    .where(eq(dataConnectors.id, id))
}

async function recordSuccess(id: DataConnectorId): Promise<void> {
  await db
    .update(dataConnectors)
    .set({ failureCount: 0, lastError: null, updatedAt: new Date() })
    .where(eq(dataConnectors.id, id))
}

/**
 * Run one connector call: render -> auth -> rate-limit -> safeFetch -> shape
 * the response. Never throws — every outcome, including a rate-limit
 * short-circuit or a network failure, is a discriminated `ConnectorExecutionResult`.
 * Persists the circuit-breaker state (failure_count/status) on every non-rate-limited
 * outcome; callers needing a persisted response sample (testConnector) do that on top.
 */
export async function executeConnector(
  connector: ConnectorRow,
  values: ConnectorValues,
  runtimeCtx: ConnectorRuntimeContext = {}
): Promise<ConnectorExecutionResult> {
  const allValues: ConnectorValues = { ...values, ...builtinValues(runtimeCtx) }

  const { count } = await incrementBucket({
    key: rateBucketKey(connector.id),
    windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
  })
  if (count !== null && count > RATE_LIMIT_PER_MINUTE) {
    return { ok: false, reason: 'rate_limited' }
  }

  const url = renderTemplate(connector.urlTemplate, allValues, { encode: 'uri' })
  const hostname = (() => {
    try {
      return new URL(url).hostname
    } catch {
      return ''
    }
  })()
  if (!isHostAllowed(hostname)) {
    const message = `Host "${hostname}" is not in CONNECTOR_ALLOWED_HOSTS`
    await recordFailure(connector.id, message)
    return { ok: false, reason: 'host_not_allowed', message }
  }

  const headers: Record<string, string> = {}
  for (const header of connector.headers) {
    headers[header.name] = renderTemplate(header.value, allValues, { encode: 'raw' })
  }
  if (connector.secretCiphertext) {
    const secret = decryptConnectorSecret(connector.secretCiphertext)
    const authHeader = buildAuthHeader(connector.auth, secret)
    if (authHeader) headers[authHeader[0]] = authHeader[1]
  }
  const body =
    connector.method === 'POST' && connector.bodyTemplate
      ? renderTemplate(connector.bodyTemplate, allValues, { encode: 'json' })
      : undefined
  const hasContentType = Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')
  if (body !== undefined && !hasContentType) {
    headers['Content-Type'] = 'application/json'
  }

  try {
    const res = await safeFetch(url, {
      method: connector.method,
      headers,
      body,
      timeoutMs: connector.timeoutMs,
    })
    const text = await res.text()
    if (!res.ok) {
      const message = `HTTP ${res.status}`
      await recordFailure(connector.id, message)
      return { ok: false, reason: 'http_error', status: res.status, message }
    }
    await recordSuccess(connector.id)
    const parsed = parseBody(text)
    const projected = connector.responsePaths?.length ? pickPaths(parsed, connector.responsePaths) : parsed
    return { ok: true, status: res.status, data: truncateResponse(projected) as JsonValue }
  } catch (error) {
    const message =
      error instanceof SsrfError || error instanceof TimeoutError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Unknown error'
    log.error({ err: error, connector_id: connector.id }, 'connector call failed')
    await recordFailure(connector.id, message)
    return { ok: false, reason: 'network_error', message }
  }
}

/**
 * Run a test call through the shared executor and persist a truncated sample
 * as `example_response` (admin-visible, model-visible via the tool spec's
 * description) plus `last_tested_at`. A failing test still records via the
 * circuit breaker inside executeConnector; only a successful body becomes the
 * stored example.
 */
export async function testConnector(
  id: DataConnectorId,
  sampleValues: ConnectorValues
): Promise<ConnectorExecutionResult> {
  const connector = await getConnectorRowForExecution(id)
  const result = await executeConnector(connector, sampleValues, {})
  await db
    .update(dataConnectors)
    .set({
      lastTestedAt: new Date(),
      ...(result.ok ? { exampleResponse: result.data } : {}),
    })
    .where(eq(dataConnectors.id, id))
  return result
}
