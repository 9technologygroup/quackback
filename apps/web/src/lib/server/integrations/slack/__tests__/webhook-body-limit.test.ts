/**
 * Slack webhook handlers cap how much raw body they buffer before signature
 * verification, rejecting oversized payloads with 413.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getPlatformCredentials = vi.fn()
const verifySlackSignature = vi.fn()
const integrationsFindFirst = vi.fn()

vi.mock('@slack/web-api', () => ({ WebClient: class {} }))
vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      integrations: { findFirst: (...a: unknown[]) => integrationsFindFirst(...a) },
      feedbackSources: { findFirst: vi.fn() },
      slackChannelMonitors: { findFirst: vi.fn() },
    },
  },
  eq: vi.fn(),
  and: vi.fn(),
  feedbackSources: {},
  integrations: {},
  slackChannelMonitors: {},
}))
vi.mock('@/lib/server/domains/platform-credentials/platform-credential.service', () => ({
  getPlatformCredentials: (...a: unknown[]) => getPlatformCredentials(...a),
}))
vi.mock('@/lib/server/config', () => ({ getBaseUrl: () => 'http://localhost:3000' }))
vi.mock('@/lib/server/logger', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}))
vi.mock('../../encryption', () => ({ decryptSecrets: vi.fn(() => ({})) }))
vi.mock('@/lib/server/domains/feedback/ingestion/feedback-ingest.service', () => ({
  ingestRawFeedback: vi.fn(),
}))
vi.mock('../verify', () => ({
  verifySlackSignature: (...a: unknown[]) => verifySlackSignature(...a),
}))

import { MAX_WEBHOOK_BODY_BYTES } from '@/lib/server/utils/read-body'
import { handleSlackEvents } from '../events'
import { handleSlackInteractivity } from '../interactivity'

function req(path: string, body: string): Request {
  return new Request(`http://localhost${path}`, { method: 'POST', body })
}

beforeEach(() => {
  vi.clearAllMocks()
  getPlatformCredentials.mockResolvedValue({ signingSecret: 'secret' })
  integrationsFindFirst.mockResolvedValue(undefined)
  verifySlackSignature.mockReturnValue(new Response('Invalid signature', { status: 401 }))
})

describe.each([
  {
    name: 'handleSlackEvents',
    handler: handleSlackEvents,
    path: '/api/integrations/slack/events',
    withinLimitBody: '{}',
  },
  {
    name: 'handleSlackInteractivity',
    handler: handleSlackInteractivity,
    path: '/api/integrations/slack/interact',
    withinLimitBody: 'payload=',
  },
])('$name body limit', ({ handler, path, withinLimitBody }) => {
  it('413s an oversized body before signature verification', async () => {
    const body = 'x'.repeat(MAX_WEBHOOK_BODY_BYTES + 1)
    const res = await handler(req(path, body))

    expect(res.status).toBe(413)
    expect(verifySlackSignature).not.toHaveBeenCalled()
  })

  it('still verifies a body within the limit', async () => {
    const res = await handler(req(path, withinLimitBody))

    expect(verifySlackSignature).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(401)
  })
})
