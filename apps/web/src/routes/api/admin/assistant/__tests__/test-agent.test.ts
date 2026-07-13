import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequireAuth = vi.fn()
vi.mock('@/lib/server/functions/auth-helpers', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}))

const mockIsAssistantConfigured = vi.fn()
const mockRunAssistantTurn = vi.fn()
const mockEnsureAssistantPrincipal = vi.fn()
const mockActivityToStatus = vi.fn()
vi.mock('@/lib/server/domains/assistant', () => ({
  isAssistantConfigured: (...args: unknown[]) => mockIsAssistantConfigured(...args),
  runAssistantTurn: (...args: unknown[]) => mockRunAssistantTurn(...args),
  ensureAssistantPrincipal: (...args: unknown[]) => mockEnsureAssistantPrincipal(...args),
  activityToStatus: (...args: unknown[]) => mockActivityToStatus(...args),
}))

const mockEnforceAiTokenBudget = vi.fn()
vi.mock('@/lib/server/domains/settings/tier-enforce', () => ({
  enforceAiTokenBudget: (...args: unknown[]) => mockEnforceAiTokenBudget(...args),
}))

import { parseAskAiSseBlock } from '@/components/help-center/ask-ai'
import { TierLimitError } from '@/lib/server/errors/tier-limit-error'
import { PERMISSIONS } from '@/lib/shared/permissions'
import { handleTestAgent } from '../test'

function request(body: unknown): Request {
  return new Request('http://localhost/api/admin/assistant/test', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

function parseSse(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split('\n\n')
    .map(parseAskAiSseBlock)
    .filter((frame): frame is { event: string; data: unknown } => frame !== null)
}

const validBody = { messages: [{ sender: 'customer', content: 'Can you help?' }] }
const safeTrace = {
  promptVersion: 'support-agent-v2',
  configRevision: 7,
  role: 'customer_support',
  tone: 'balanced',
  responseLength: 'brief',
  appliedGuidance: [{ id: 'guidance_1', name: 'Refund policy' }],
  toolCalls: [
    { name: 'search_knowledge', outcome: 'read' },
    { name: 'create_ticket', outcome: 'simulated' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAuth.mockResolvedValue({ principal: { id: 'principal_admin' } })
  mockIsAssistantConfigured.mockReturnValue(true)
  mockEnforceAiTokenBudget.mockResolvedValue(undefined)
  mockEnsureAssistantPrincipal.mockResolvedValue({ id: 'principal_assistant' })
  mockActivityToStatus.mockReturnValue('searching_kb')
  mockRunAssistantTurn.mockResolvedValue({
    status: 'answered',
    text: 'I can help.',
    citations: [],
    escalation: undefined,
    trace: safeTrace,
  })
})

describe('POST /api/admin/assistant/test', () => {
  it('requires assistant.manage and maps genuine denial to 403', async () => {
    mockRequireAuth.mockRejectedValue(
      new Error("Access denied: Requires permission 'assistant.manage', role member lacks it")
    )

    const response = await handleTestAgent({ request: request(validBody) })

    expect(response.status).toBe(403)
    expect(mockRequireAuth).toHaveBeenCalledWith({ permission: PERMISSIONS.ASSISTANT_MANAGE })
    expect(mockRunAssistantTurn).not.toHaveBeenCalled()
  })

  it('does not disguise auth infrastructure failures as permission denial', async () => {
    mockRequireAuth.mockRejectedValue(new Error('session store unavailable'))

    await expect(handleTestAgent({ request: request(validBody) })).rejects.toThrow(
      'session store unavailable'
    )
    expect(mockRunAssistantTurn).not.toHaveBeenCalled()
  })

  it('rejects non-customer thread roles and an assistant-final thread', async () => {
    const human = await handleTestAgent({
      request: request({ messages: [{ sender: 'human_agent', content: 'Private note' }] }),
    })
    const assistantFinal = await handleTestAgent({
      request: request({ messages: [{ sender: 'assistant', content: 'Previous reply' }] }),
    })

    expect(human.status).toBe(400)
    expect(assistantFinal.status).toBe(400)
    expect(mockRunAssistantTurn).not.toHaveBeenCalled()
  })

  it('matches the production 40-message window and 4,000-character turn bound', async () => {
    const tooManyMessages = Array.from({ length: 41 }, (_, index) => ({
      sender: index % 2 === 0 ? 'customer' : 'assistant',
      content: `Turn ${index + 1}`,
    }))
    const tooMany = await handleTestAgent({ request: request({ messages: tooManyMessages }) })
    const tooLong = await handleTestAgent({
      request: request({ messages: [{ sender: 'customer', content: 'x'.repeat(4_001) }] }),
    })

    expect(tooMany.status).toBe(400)
    expect(tooLong.status).toBe(400)
    expect(mockRunAssistantTurn).not.toHaveBeenCalled()
  })

  it('checks that an assistant model is configured before spending budget', async () => {
    mockIsAssistantConfigured.mockReturnValue(false)

    const response = await handleTestAgent({ request: request(validBody) })

    expect(response.status).toBe(503)
    expect(mockEnforceAiTokenBudget).not.toHaveBeenCalled()
  })

  it('returns the complete structured AI budget error without starting a turn', async () => {
    mockEnforceAiTokenBudget.mockRejectedValue(
      new TierLimitError({
        limit: 'aiTokensPerMonth',
        message: 'Monthly AI token budget reached',
        current: 1_000,
        max: 1_000,
      })
    )

    const response = await handleTestAgent({ request: request(validBody) })

    expect(response.status).toBe(402)
    expect(await response.json()).toEqual({
      error: 'tier_limit_exceeded',
      limit: 'aiTokensPerMonth',
      message: 'Monthly AI token budget reached',
      current: 1_000,
      max: 1_000,
    })
    expect(mockEnsureAssistantPrincipal).not.toHaveBeenCalled()
    expect(mockRunAssistantTurn).not.toHaveBeenCalled()
  })

  it('uses the exact production turn seam in explicit no-write simulation mode', async () => {
    const response = await handleTestAgent({ request: request(validBody) })
    await response.text()

    expect(mockRunAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: validBody.messages,
        assistantPrincipalId: 'principal_assistant',
        conversationId: null,
        role: 'customer_support',
        surface: 'widget',
        simulate: true,
      })
    )
    const input = mockRunAssistantTurn.mock.calls[0][0]
    expect(input).not.toHaveProperty('ticketId')
    expect(input).not.toHaveProperty('involvementId')
    expect(input).not.toHaveProperty('latestCustomerMessageId')
    expect(input).not.toHaveProperty('askerActor')
    expect(input).not.toHaveProperty('writeToolPolicy')
    expect(input).not.toHaveProperty('copilotIntent')
  })

  it('accepts only the live customer channel vocabulary and defaults to widget', async () => {
    const email = await handleTestAgent({
      request: request({ ...validBody, channel: 'email' }),
    })
    await email.text()
    expect(mockRunAssistantTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ role: 'customer_support', surface: 'email' })
    )

    const invalid = await handleTestAgent({
      request: request({ ...validBody, channel: 'copilot' }),
    })
    expect(invalid.status).toBe(400)
  })

  it('emits V2 activity, delta, and an exactly allowlisted final trace', async () => {
    mockRunAssistantTurn.mockImplementation(
      async (input: {
        onActivity: (activity: unknown) => void
        onTextDelta: (text: string) => void
      }) => {
        input.onActivity({ kind: 'tool', tool: 'search_knowledge' })
        input.onTextDelta('I can ')
        return {
          status: 'answered',
          text: 'I can help. [1]',
          citations: [
            {
              type: 'article',
              id: 'article_1',
              title: 'Refunds',
              url: '/hc/refunds',
              internal: true,
              updatedAt: '2026-07-01T00:00:00.000Z',
              rawResult: 'private result',
            },
          ],
          escalation: {
            reason: 'explicit_request',
            mode: 'handoff',
            customerNeed: 'private packet',
            attempted: ['private reasoning'],
            recommendedNextStep: 'private instruction',
          },
          trace: {
            ...safeTrace,
            configFallbackReason: 'database_read_failed',
            rawPrompt: 'hidden prompt',
            appliedGuidance: [
              {
                id: 'guidance_1',
                name: 'Refund policy',
                instruction: 'hidden instruction',
              },
            ],
            toolCalls: [
              {
                name: 'search_knowledge',
                outcome: 'read',
                args: { query: 'secret' },
                result: 'private result',
              },
              { name: 'create_ticket', outcome: 'simulated', args: { body: 'secret' } },
            ],
          },
        }
      }
    )

    const response = await handleTestAgent({ request: request(validBody) })
    const text = await response.text()
    const frames = parseSse(text)

    expect(frames).toEqual([
      {
        event: 'assistant-test.v2.activity',
        data: { status: 'searching_kb' },
      },
      {
        event: 'assistant-test.v2.delta',
        data: { text: 'I can ' },
      },
      {
        event: 'assistant-test.v2.final',
        data: {
          text: 'I can help. [1]',
          citations: [{ type: 'article', id: 'article_1', title: 'Refunds', url: '/hc/refunds' }],
          escalation: { reason: 'explicit_request', mode: 'handoff' },
          trace: safeTrace,
        },
      },
    ])
    expect(text).not.toContain('assistant-sandbox.v1')
    expect(text).not.toContain('hidden prompt')
    expect(text).not.toContain('hidden instruction')
    expect(text).not.toContain('private')
    expect(text).not.toContain('"args"')
    expect(text).not.toContain('"result"')
  })

  it('emits one terminal V2 error and closes the stream when the runtime fails', async () => {
    mockRunAssistantTurn.mockRejectedValue(new Error('provider secret failure'))

    const response = await handleTestAgent({ request: request(validBody) })
    const frames = parseSse(await response.text())

    expect(frames).toEqual([
      {
        event: 'assistant-test.v2.error',
        data: { code: 'TURN_FAILED', message: 'The test run failed' },
      },
    ])
    expect(JSON.stringify(frames)).not.toContain('provider secret failure')
  })
})
