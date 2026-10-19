/**
 * POST /api/v1/status/incidents when an affected service has been deleted.
 *
 * The domain rejects it with a VALIDATION_ERROR whose message is shown as is
 * by the dashboard and returned as is to API callers, so it must read well
 * for both (no "refresh the page"), and the 400's shape stays the API's
 * standard error envelope.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ValidationError } from '@/lib/shared/errors'

const mockWithApiKeyAuth = vi.fn()
const mockCreateIncident = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: vi.fn(() => (opts: unknown) => ({ options: opts })),
}))
vi.mock('@/lib/server/domains/api/auth', () => ({
  withApiKeyAuth: (...args: unknown[]) => mockWithApiKeyAuth(...args),
}))
vi.mock('@/lib/server/domains/status', () => ({
  createIncident: (...args: unknown[]) => mockCreateIncident(...args),
}))

import { Route } from '../incidents/index'

type Handlers = { POST: (args: { request: Request }) => Promise<Response> }
const { POST } = (Route as unknown as { options: { server: { handlers: Handlers } } }).options
  .server.handlers

const DELETED_SERVICE_MESSAGE = 'An affected service has been deleted. Choose the services again.'

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://test/api/v1/status/incidents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mockWithApiKeyAuth.mockReset().mockResolvedValue({ principalId: 'principal_1' })
  mockCreateIncident.mockReset()
})

describe('POST /api/v1/status/incidents with a deleted service', () => {
  it('returns the standard 400 envelope with wording that fits an API caller', async () => {
    mockCreateIncident.mockRejectedValue(
      new ValidationError('VALIDATION_ERROR', DELETED_SERVICE_MESSAGE)
    )

    const res = await POST({
      request: makeRequest({
        kind: 'incident',
        title: 'Errors',
        status: 'investigating',
        body: 'Looking into it.',
        affectedComponents: [
          {
            componentId: 'status_component_01h455vb4pex5vsknk084sn02q',
            componentStatus: 'major_outage',
          },
        ],
      }),
    })

    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: { code: string; message: string } }
    expect(json).toEqual({
      error: { code: 'VALIDATION_ERROR', message: DELETED_SERVICE_MESSAGE },
    })
    expect(json.error.message).not.toMatch(/refresh/i)
  })
})
