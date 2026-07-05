/**
 * executeConnector / testConnector coverage: rendering, auth header
 * construction, the rate-limit short-circuit, the host allowlist, the
 * circuit breaker (increment + auto-disable + reset-on-success), and
 * response shaping (JSON parse, dot-path projection, truncation). The
 * network call (safeFetch) and the rate bucket are mocked; the DB is the
 * real rolled-back fixture so the circuit-breaker persistence is genuine.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import { dataConnectors } from '@/lib/server/db'

vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

vi.mock('@/lib/server/domains/assistant/assistant.toolspec', () => ({
  ASSISTANT_TOOL_SPECS: {},
}))

vi.mock('../connector.encryption', () => ({
  encryptConnectorSecret: (secret: string) => `enc:${secret}`,
  decryptConnectorSecret: (ciphertext: string) => ciphertext.replace(/^enc:/, ''),
}))

const mockSafeFetch = vi.fn()
vi.mock('@/lib/server/content/ssrf-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/content/ssrf-guard')>()),
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
}))

const mockIncrementBucket = vi.fn()
vi.mock('@/lib/server/utils/redis-rate-bucket', () => ({
  incrementBucket: (...args: unknown[]) => mockIncrementBucket(...args),
}))

const mockConfig = vi.hoisted(() => ({ connectorAllowedHosts: undefined as string | undefined }))
vi.mock('@/lib/server/config', () => ({ config: mockConfig }))

import { createConnector } from '../connector.service'
import { executeConnector, testConnector, getConnectorRowForExecution } from '../connector.execute'
import type { CreateConnectorInput } from '../connector.types'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

const fixture = await createDbTestFixture({
  probe: async (db) => void (await db.select({ id: dataConnectors.id }).from(dataConnectors).limit(0)),
})

describe.skipIf(!fixture.available)('connector execution (real DB, rolled back)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfig.connectorAllowedHosts = undefined
    mockIncrementBucket.mockResolvedValue({ count: 1 })
  })
  afterEach(fixture.rollback)
  beforeEach(fixture.begin)
  afterAll(fixture.close)

  async function makeConnector(overrides: Partial<CreateConnectorInput> = {}) {
    const created = await createConnector(
      {
        name: overrides.name ?? 'Get User',
        description: 'x',
        method: overrides.method ?? 'GET',
        urlTemplate: overrides.urlTemplate ?? 'https://api.example.com/users/{id}',
        headers: overrides.headers,
        auth: overrides.auth,
        secret: overrides.secret,
        inputs: overrides.inputs ?? [{ name: 'id', type: 'string', required: true }],
        bodyTemplate: overrides.bodyTemplate,
        timeoutMs: overrides.timeoutMs,
      },
      null
    )
    return getConnectorRowForExecution(created.id)
  }

  describe('rate limiting', () => {
    it('returns rate_limited and never calls safeFetch when over budget', async () => {
      mockIncrementBucket.mockResolvedValue({ count: 31 })
      const connector = await makeConnector()
      const result = await executeConnector(connector, { id: '1' })
      expect(result).toEqual({ ok: false, reason: 'rate_limited' })
      expect(mockSafeFetch).not.toHaveBeenCalled()
    })

    it('keys the bucket by connector id', async () => {
      const connector = await makeConnector()
      mockSafeFetch.mockResolvedValue(jsonResponse({ ok: true }))
      await executeConnector(connector, { id: '1' })
      expect(mockIncrementBucket).toHaveBeenCalledWith(
        expect.objectContaining({ key: expect.stringContaining(connector.id) })
      )
    })

    it('fails open (still calls) when redis errors (count null)', async () => {
      mockIncrementBucket.mockResolvedValue({ count: null })
      const connector = await makeConnector()
      mockSafeFetch.mockResolvedValue(jsonResponse({ ok: true }))
      const result = await executeConnector(connector, { id: '1' })
      expect(result.ok).toBe(true)
    })
  })

  describe('host allowlist', () => {
    it('blocks a host outside CONNECTOR_ALLOWED_HOSTS and never fetches', async () => {
      mockConfig.connectorAllowedHosts = 'good.example.com'
      const connector = await makeConnector({ urlTemplate: 'https://evil.example.com/users/{id}' })
      const result = await executeConnector(connector, { id: '1' })
      expect(result).toMatchObject({ ok: false, reason: 'host_not_allowed' })
      expect(mockSafeFetch).not.toHaveBeenCalled()
    })

    it('allows a host on the allowlist', async () => {
      mockConfig.connectorAllowedHosts = 'api.example.com, other.example.com'
      const connector = await makeConnector()
      mockSafeFetch.mockResolvedValue(jsonResponse({ ok: true }))
      const result = await executeConnector(connector, { id: '1' })
      expect(result.ok).toBe(true)
    })

    it('allows any host when unset', async () => {
      const connector = await makeConnector({ urlTemplate: 'https://anything.example.com/users/{id}' })
      mockSafeFetch.mockResolvedValue(jsonResponse({ ok: true }))
      const result = await executeConnector(connector, { id: '1' })
      expect(result.ok).toBe(true)
    })
  })

  describe('request construction', () => {
    it('renders the url and calls safeFetch with the connector timeout', async () => {
      const connector = await makeConnector({ timeoutMs: 5000 })
      mockSafeFetch.mockResolvedValue(jsonResponse({ ok: true }))
      await executeConnector(connector, { id: '42' })
      expect(mockSafeFetch).toHaveBeenCalledWith(
        'https://api.example.com/users/42',
        expect.objectContaining({ method: 'GET', timeoutMs: 5000 })
      )
    })

    it('builds a bearer Authorization header from the decrypted secret', async () => {
      const connector = await makeConnector({ auth: { type: 'bearer' }, secret: 'sk_live_123' })
      mockSafeFetch.mockResolvedValue(jsonResponse({ ok: true }))
      await executeConnector(connector, { id: '1' })
      const [, init] = mockSafeFetch.mock.calls[0] as [string, { headers: Record<string, string> }]
      expect(init.headers.Authorization).toBe('Bearer sk_live_123')
    })

    it('builds a custom header auth from headerName', async () => {
      const connector = await makeConnector({
        auth: { type: 'header', headerName: 'X-Api-Key' },
        secret: 'key_abc',
      })
      mockSafeFetch.mockResolvedValue(jsonResponse({ ok: true }))
      await executeConnector(connector, { id: '1' })
      const [, init] = mockSafeFetch.mock.calls[0] as [string, { headers: Record<string, string> }]
      expect(init.headers['X-Api-Key']).toBe('key_abc')
    })

    it('builds a base64 Basic Authorization header', async () => {
      const connector = await makeConnector({ auth: { type: 'basic' }, secret: 'user:pass' })
      mockSafeFetch.mockResolvedValue(jsonResponse({ ok: true }))
      await executeConnector(connector, { id: '1' })
      const [, init] = mockSafeFetch.mock.calls[0] as [string, { headers: Record<string, string> }]
      expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`)
    })

    it('renders a POST body template and defaults Content-Type to JSON', async () => {
      const connector = await makeConnector({
        method: 'POST',
        urlTemplate: 'https://api.example.com/users',
        bodyTemplate: '{"id":"{id}"}',
      })
      mockSafeFetch.mockResolvedValue(jsonResponse({ ok: true }))
      await executeConnector(connector, { id: '7' })
      const [, init] = mockSafeFetch.mock.calls[0] as [
        string,
        { body: string; headers: Record<string, string> },
      ]
      expect(init.body).toBe('{"id":"7"}')
      expect(init.headers['Content-Type']).toBe('application/json')
    })

    it('renders header values with {token} placeholders', async () => {
      const connector = await makeConnector({ headers: [{ name: 'X-Trace', value: 'id={id}' }] })
      mockSafeFetch.mockResolvedValue(jsonResponse({ ok: true }))
      await executeConnector(connector, { id: '9' })
      const [, init] = mockSafeFetch.mock.calls[0] as [string, { headers: Record<string, string> }]
      expect(init.headers['X-Trace']).toBe('id=9')
    })
  })

  describe('response shaping', () => {
    it('parses a JSON body and returns it as data', async () => {
      const connector = await makeConnector()
      mockSafeFetch.mockResolvedValue(jsonResponse({ name: 'Ann', id: '1' }))
      const result = await executeConnector(connector, { id: '1' })
      expect(result).toMatchObject({ ok: true, data: { name: 'Ann', id: '1' } })
    })

    it('falls back to the raw text for a non-JSON body', async () => {
      const connector = await makeConnector()
      mockSafeFetch.mockResolvedValue(new Response('plain text', { status: 200 }))
      const result = await executeConnector(connector, { id: '1' })
      expect(result).toMatchObject({ ok: true, data: 'plain text' })
    })

    it('projects only the configured response_paths', async () => {
      const created = await createConnector(
        {
          name: 'Paths',
          description: 'x',
          method: 'GET',
          urlTemplate: 'https://api.example.com/x',
        },
        null
      )
      await testDb
        .update(dataConnectors)
        .set({ responsePaths: ['user.name', 'user.missing'] })
        .where(eq(dataConnectors.id, created.id))
      const connector = await getConnectorRowForExecution(created.id)
      mockSafeFetch.mockResolvedValue(jsonResponse({ user: { name: 'Ann', id: '1' } }))
      const result = await executeConnector(connector, {})
      expect(result).toMatchObject({
        ok: true,
        data: { 'user.name': 'Ann', 'user.missing': null },
      })
    })

    it('truncates an oversized response body', async () => {
      const connector = await makeConnector()
      mockSafeFetch.mockResolvedValue(jsonResponse({ blob: 'x'.repeat(10_000) }))
      const result = await executeConnector(connector, { id: '1' })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(JSON.stringify(result.data).length).toBeLessThan(10_000)
      }
    })
  })

  describe('circuit breaker', () => {
    it('increments failure_count and sets last_error on a non-2xx response', async () => {
      const connector = await makeConnector()
      mockSafeFetch.mockResolvedValue(new Response('nope', { status: 500 }))
      const result = await executeConnector(connector, { id: '1' })
      expect(result).toMatchObject({ ok: false, reason: 'http_error', status: 500 })

      const [row] = await testDb.select().from(dataConnectors).where(eq(dataConnectors.id, connector.id))
      expect(row.failureCount).toBe(1)
      expect(row.lastError).toBe('HTTP 500')
      expect(row.status).toBe('active')
    })

    it('increments failure_count on a network error', async () => {
      const connector = await makeConnector()
      mockSafeFetch.mockRejectedValue(new Error('ECONNRESET'))
      const result = await executeConnector(connector, { id: '1' })
      expect(result).toMatchObject({ ok: false, reason: 'network_error', message: 'ECONNRESET' })

      const [row] = await testDb.select().from(dataConnectors).where(eq(dataConnectors.id, connector.id))
      expect(row.failureCount).toBe(1)
    })

    it('auto-disables once failure_count reaches the threshold', async () => {
      const connector = await makeConnector()
      await testDb
        .update(dataConnectors)
        .set({ failureCount: 49 })
        .where(eq(dataConnectors.id, connector.id))
      mockSafeFetch.mockResolvedValue(new Response('nope', { status: 500 }))

      await executeConnector(connector, { id: '1' })

      const [row] = await testDb.select().from(dataConnectors).where(eq(dataConnectors.id, connector.id))
      expect(row.failureCount).toBe(50)
      expect(row.status).toBe('disabled')
    })

    it('resets failure_count to 0 on a successful call', async () => {
      const connector = await makeConnector()
      await testDb
        .update(dataConnectors)
        .set({ failureCount: 12, lastError: 'previous failure' })
        .where(eq(dataConnectors.id, connector.id))
      mockSafeFetch.mockResolvedValue(jsonResponse({ ok: true }))

      await executeConnector(connector, { id: '1' })

      const [row] = await testDb.select().from(dataConnectors).where(eq(dataConnectors.id, connector.id))
      expect(row.failureCount).toBe(0)
      expect(row.lastError).toBeNull()
    })
  })

  describe('testConnector', () => {
    it('persists a truncated example_response and last_tested_at on success', async () => {
      const created = await createConnector(
        { name: 'Test Me', description: 'x', method: 'GET', urlTemplate: 'https://api.example.com/x' },
        null
      )
      mockSafeFetch.mockResolvedValue(jsonResponse({ hello: 'world' }))

      const result = await testConnector(created.id, {})
      expect(result).toMatchObject({ ok: true })

      const [row] = await testDb.select().from(dataConnectors).where(eq(dataConnectors.id, created.id))
      expect(row.exampleResponse).toEqual({ hello: 'world' })
      expect(row.lastTestedAt).not.toBeNull()
    })

    it('still stamps last_tested_at on a failing test, without an example', async () => {
      const created = await createConnector(
        { name: 'Test Fail', description: 'x', method: 'GET', urlTemplate: 'https://api.example.com/x' },
        null
      )
      mockSafeFetch.mockResolvedValue(new Response('err', { status: 503 }))

      const result = await testConnector(created.id, {})
      expect(result).toMatchObject({ ok: false, reason: 'http_error' })

      const [row] = await testDb.select().from(dataConnectors).where(eq(dataConnectors.id, created.id))
      expect(row.lastTestedAt).not.toBeNull()
      expect(row.exampleResponse).toBeNull()
    })
  })
})
