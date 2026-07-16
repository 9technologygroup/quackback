/**
 * Unit tests for POST /api/admin/assistant/suggest (QUINN-PROACTIVE-SUGGESTIONS-SPEC.md):
 * the shared copilot gate sequence PLUS the `assistantProactiveSuggestions`
 * flag layer, the targeted pre-turn item read (`loadAssistantItemState`) that
 * backs the closed-item and lastCustomerMessageId-staleness gates (both 409
 * CONFLICT — the client renders nothing for a 409), the AG-UI request parsing
 * (the item ref + lastCustomerMessageId on forwardedProps), the terminal
 * RUN_FINISHED.result carrying the `SuggestFinalPayload`, and the exact
 * `streamAssistantTurn` input this route commits to (`role: 'suggested_reply'`,
 * `surface: 'copilot'`, and no messages or caller-owned tool policy: the role
 * owns those invariants inside the runtime). `streamAssistantTurn` is mocked
 * throughout, mirroring copilot.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAuth = vi.fn()
const mockPolicyActorFromAuth = vi.fn()
vi.mock('@/lib/server/functions/auth-helpers', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  policyActorFromAuth: (...args: unknown[]) => mockPolicyActorFromAuth(...args),
}))

const mockIsAssistantConfigured = vi.fn()
const mockStreamAssistantTurn = vi.fn()
const mockEnsureAssistantPrincipal = vi.fn()
const mockLoadAssistantItemState = vi.fn()
vi.mock('@/lib/server/domains/assistant', () => ({
  isAssistantConfigured: (...args: unknown[]) => mockIsAssistantConfigured(...args),
  streamAssistantTurn: (...args: unknown[]) => mockStreamAssistantTurn(...args),
  ensureAssistantPrincipal: (...args: unknown[]) => mockEnsureAssistantPrincipal(...args),
  loadAssistantItemState: (...args: unknown[]) => mockLoadAssistantItemState(...args),
}))

// Two distinct flags gate this route: inboxAi (inside gateCopilotAguiRequest)
// and assistantProactiveSuggestions (this route's own extra layer). Both
// default on; individual tests flip one at a time.
const mockIsFeatureEnabled = vi.fn()
const mockIsCopilotCapabilityEnabled = vi.fn()
vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
  isCopilotCapabilityEnabled: (...args: unknown[]) => mockIsCopilotCapabilityEnabled(...args),
}))

const mockAssertConversationViewable = vi.fn()
vi.mock('@/lib/server/domains/conversation/conversation.service', () => ({
  assertConversationViewable: (...args: unknown[]) => mockAssertConversationViewable(...args),
}))

const mockEnforceAiTokenBudget = vi.fn()
vi.mock('@/lib/server/domains/settings/tier-enforce', () => ({
  enforceAiTokenBudget: (...args: unknown[]) => mockEnforceAiTokenBudget(...args),
}))

// `assertTicketVisible` (copilot-gate.ts) runs for real, gated on the same
// db.select chain fake copilot.test.ts uses.
const mockTicketLookup = vi.fn()
vi.mock('@/lib/server/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/db')>()
  return {
    ...actual,
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: (...args: unknown[]) => mockTicketLookup(...args),
          })),
        })),
      })),
    },
  }
})

import { handleSuggest } from '../suggest'
import type { StreamAssistantTurnOptions } from '@/lib/server/domains/assistant/assistant.runtime'
import { TierLimitError } from '@/lib/server/errors/tier-limit-error'
import { NotFoundError } from '@/lib/shared/errors'
import { generateId } from '@quackback/ids'

const CONVERSATION_ID = generateId('conversation')
const TICKET_ID = generateId('ticket')
const LATEST_MESSAGE_ID = generateId('conversation_msg')
const STALE_MESSAGE_ID = generateId('conversation_msg')

/** Build an AG-UI RunAgentInput body: the item ref + lastCustomerMessageId on
 *  forwardedProps, plus the store's ignored placeholder message. */
function aguiBody(forwardedProps: Record<string, unknown>): Record<string, unknown> {
  return {
    threadId: 'thread-test',
    runId: 'run-test',
    messages: [{ id: 'p', role: 'user', content: 'draft' }],
    tools: [],
    context: [],
    state: {},
    forwardedProps,
  }
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/assistant/suggest', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** Parse toServerSentEventsResponse output: `data: <json>` blocks. */
function parseAguiSse(text: string): Array<Record<string, unknown> & { type: string }> {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice('data: '.length)))
}

const SKIP_FINAL = { text: '', citations: [], internalSourced: false, skip: true }

/** The turn result the mocked streamAssistantTurn maps through the route's
 *  buildFinalPayload. */
let nextTurnResult: unknown

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAuth.mockResolvedValue({ principal: { id: 'principal_1' } })
  mockPolicyActorFromAuth.mockResolvedValue({ principalId: 'principal_1' })
  mockIsFeatureEnabled.mockResolvedValue(true)
  mockIsCopilotCapabilityEnabled.mockResolvedValue(true)
  mockIsAssistantConfigured.mockReturnValue(true)
  mockEnforceAiTokenBudget.mockResolvedValue(undefined)
  mockAssertConversationViewable.mockResolvedValue({ id: CONVERSATION_ID })
  mockTicketLookup.mockResolvedValue([{ id: TICKET_ID }])
  mockEnsureAssistantPrincipal.mockResolvedValue({ id: 'principal_assistant' })
  mockLoadAssistantItemState.mockResolvedValue({
    closed: false,
    latestCustomerMessageId: LATEST_MESSAGE_ID,
  })
  nextTurnResult = {
    status: 'answered',
    text: 'Here is a draft reply.',
    citations: [],
    internalSourced: false,
    proposedActions: [],
    answerType: 'draft_reply',
    skip: false,
  }
  mockStreamAssistantTurn.mockImplementation((options: StreamAssistantTurnOptions) =>
    (async function* () {
      yield { type: 'RUN_STARTED', ...options.wire }
      yield {
        type: 'RUN_FINISHED',
        ...options.wire,
        finishReason: 'stop',
        result: options.buildFinalPayload(nextTurnResult as never),
      }
    })()
  )
})

const validBody = () =>
  aguiBody({ conversationId: CONVERSATION_ID, lastCustomerMessageId: LATEST_MESSAGE_ID })

/** The turn input the route handed to streamAssistantTurn. */
function turnInput(): Record<string, unknown> {
  return (mockStreamAssistantTurn.mock.calls[0][0] as StreamAssistantTurnOptions)
    .input as unknown as Record<string, unknown>
}

/** The final payload on the terminal RUN_FINISHED. */
async function finalResult(res: Response): Promise<unknown> {
  const chunks = parseAguiSse(await res.text())
  return (chunks.at(-1) as { result?: unknown }).result
}

describe('POST /api/admin/assistant/suggest', () => {
  it('403s when the caller lacks copilot.use', async () => {
    mockRequireAuth.mockRejectedValue(
      new Error("Access denied: Requires permission 'copilot.use', role member lacks it")
    )
    const res = await handleSuggest({ request: makeRequest(validBody()) })
    expect(res.status).toBe(403)
    expect(mockIsFeatureEnabled).not.toHaveBeenCalled()
    expect(mockStreamAssistantTurn).not.toHaveBeenCalled()
  })

  it('400s on a non-AG-UI body', async () => {
    const res = await handleSuggest({
      request: makeRequest({
        conversationId: CONVERSATION_ID,
        lastCustomerMessageId: LATEST_MESSAGE_ID,
      }),
    })
    expect(res.status).toBe(400)
  })

  it('400s on a missing lastCustomerMessageId', async () => {
    const res = await handleSuggest({
      request: makeRequest(aguiBody({ conversationId: CONVERSATION_ID })),
    })
    expect(res.status).toBe(400)
  })

  it('400s on a malformed lastCustomerMessageId', async () => {
    const res = await handleSuggest({
      request: makeRequest(
        aguiBody({ conversationId: CONVERSATION_ID, lastCustomerMessageId: 'not-a-typeid' })
      ),
    })
    expect(res.status).toBe(400)
  })

  it('404s when the inboxAi flag is off (the shared gate)', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false)
    const res = await handleSuggest({ request: makeRequest(validBody()) })
    expect(res.status).toBe(404)
    expect(mockStreamAssistantTurn).not.toHaveBeenCalled()
  })

  it('404s when inboxAi is on but assistantProactiveSuggestions is off (the extra gate layer)', async () => {
    mockIsFeatureEnabled.mockImplementation(async (flag: string) => flag === 'inboxAi')
    const res = await handleSuggest({ request: makeRequest(validBody()) })
    expect(res.status).toBe(404)
    expect(mockLoadAssistantItemState).not.toHaveBeenCalled()
    expect(mockStreamAssistantTurn).not.toHaveBeenCalled()
  })

  it('404s when the suggestedReplies capability is off (v3 config gate)', async () => {
    mockIsCopilotCapabilityEnabled.mockResolvedValue(false)
    const res = await handleSuggest({ request: makeRequest(validBody()) })
    expect(res.status).toBe(404)
    expect(mockLoadAssistantItemState).not.toHaveBeenCalled()
    expect(mockStreamAssistantTurn).not.toHaveBeenCalled()
  })

  it('503s when the assistant is not configured', async () => {
    mockIsAssistantConfigured.mockReturnValue(false)
    const res = await handleSuggest({ request: makeRequest(validBody()) })
    expect(res.status).toBe(503)
  })

  it('responds with the tier-limit error when the ai token budget is exceeded', async () => {
    mockEnforceAiTokenBudget.mockRejectedValue(
      new TierLimitError({ limit: 'aiTokensPerMonth', message: "You've used your AI budget" })
    )
    const res = await handleSuggest({ request: makeRequest(validBody()) })
    expect(res.status).toBe(402)
    expect(mockStreamAssistantTurn).not.toHaveBeenCalled()
  })

  it('404s when the conversation does not exist (or is not viewable)', async () => {
    mockAssertConversationViewable.mockRejectedValue(
      new NotFoundError('CONVERSATION_NOT_FOUND', 'Conversation not found')
    )
    const res = await handleSuggest({ request: makeRequest(validBody()) })
    expect(res.status).toBe(404)
    expect(mockStreamAssistantTurn).not.toHaveBeenCalled()
  })

  it('409s when lastCustomerMessageId is stale (a newer customer message now exists)', async () => {
    const res = await handleSuggest({
      request: makeRequest(
        aguiBody({ conversationId: CONVERSATION_ID, lastCustomerMessageId: STALE_MESSAGE_ID })
      ),
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('CONFLICT')
    expect(mockStreamAssistantTurn).not.toHaveBeenCalled()
  })

  it('409s when the item has no customer message at all', async () => {
    mockLoadAssistantItemState.mockResolvedValue({ closed: false, latestCustomerMessageId: null })
    const res = await handleSuggest({ request: makeRequest(validBody()) })
    expect(res.status).toBe(409)
    expect(mockStreamAssistantTurn).not.toHaveBeenCalled()
  })

  it('409s on a CLOSED conversation without spending a turn, even when lastCustomerMessageId matches', async () => {
    mockLoadAssistantItemState.mockResolvedValue({
      closed: true,
      latestCustomerMessageId: LATEST_MESSAGE_ID,
    })
    const res = await handleSuggest({ request: makeRequest(validBody()) })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('CONFLICT')
    expect(mockStreamAssistantTurn).not.toHaveBeenCalled()
  })

  it('409s when the item row vanished between the viewability gate and the pre-turn read (defensive)', async () => {
    mockLoadAssistantItemState.mockResolvedValue(null)
    const res = await handleSuggest({ request: makeRequest(validBody()) })
    expect(res.status).toBe(409)
    expect(mockStreamAssistantTurn).not.toHaveBeenCalled()
  })

  it('reads the item state through the targeted pre-turn read, never a full thread load', async () => {
    await handleSuggest({ request: makeRequest(validBody()) })
    expect(mockLoadAssistantItemState).toHaveBeenCalledWith(CONVERSATION_ID, null)
  })

  it('calls the runtime with the explicit suggested-reply boundary and no messages', async () => {
    await handleSuggest({ request: makeRequest(validBody()) })

    expect(turnInput()).toMatchObject({
      conversationId: CONVERSATION_ID,
      role: 'suggested_reply',
      surface: 'copilot',
      latestCustomerMessageId: LATEST_MESSAGE_ID,
    })
    // The suggestion invariants live on the intent (COPILOT_INTENT_PROFILES,
    // assistant.runtime.ts), not on this caller — pinned there, absent here.
    const input = turnInput()
    expect(input).not.toHaveProperty('writeToolPolicy')
    expect(input).not.toHaveProperty('askerActor')
    expect(input).not.toHaveProperty('messages')
    expect(input).not.toHaveProperty('onTextDelta')
  })

  it('attributes the turn to the viewing teammate without threading the gate actor', async () => {
    const resolvedActor = { principalId: 'principal_1' }
    mockPolicyActorFromAuth.mockResolvedValue(resolvedActor)

    await handleSuggest({ request: makeRequest(validBody()) })

    expect(turnInput()).toMatchObject({ actorPrincipalId: 'principal_1' })
    expect(mockAssertConversationViewable).toHaveBeenCalledWith(CONVERSATION_ID, resolvedActor)
    expect(turnInput()).not.toHaveProperty('askerActor')
  })

  it('streams the final payload on RUN_FINISHED.result for a real draft', async () => {
    nextTurnResult = {
      status: 'answered',
      text: 'Here is a draft.',
      citations: [{ type: 'article', id: 'kb_article_1', title: 'T', url: '/u' }],
      internalSourced: false,
      proposedActions: [],
      answerType: 'draft_reply',
      skip: false,
    }

    const res = await handleSuggest({ request: makeRequest(validBody()) })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')

    expect(await finalResult(res)).toEqual({
      text: 'Here is a draft.',
      citations: [{ type: 'article', id: 'kb_article_1', title: 'T', url: '/u' }],
      internalSourced: false,
    })
  })

  it('maps a tool-derived honest miss to the skip payload', async () => {
    nextTurnResult = {
      status: 'answered',
      text: 'Would have been a guess.',
      citations: [],
      internalSourced: false,
      proposedActions: [],
      answerType: 'draft_reply',
      skip: true,
    }
    const res = await handleSuggest({ request: makeRequest(validBody()) })
    expect(await finalResult(res)).toEqual(SKIP_FINAL)
  })

  it('maps a done-but-EMPTY final text to a skip so a malformed result cannot render a bare card', async () => {
    nextTurnResult = {
      status: 'answered',
      text: '',
      citations: [],
      internalSourced: false,
      proposedActions: [],
      answerType: 'draft_reply',
      skip: false,
    }
    const res = await handleSuggest({ request: makeRequest(validBody()) })
    expect(await finalResult(res)).toEqual(SKIP_FINAL)
  })

  it('maps whitespace-only final text to a skip too (trim, not truthiness)', async () => {
    nextTurnResult = {
      status: 'answered',
      text: '  \n ',
      citations: [],
      internalSourced: false,
      proposedActions: [],
      answerType: 'draft_reply',
      skip: false,
    }
    const res = await handleSuggest({ request: makeRequest(validBody()) })
    expect(await finalResult(res)).toEqual(SKIP_FINAL)
  })

  it('maps a suppressed turn to the skip payload (defensive; intent-owned messages never carry human_agent)', async () => {
    nextTurnResult = { status: 'suppressed', reason: 'silence' }
    const res = await handleSuggest({ request: makeRequest(validBody()) })
    expect(await finalResult(res)).toEqual(SKIP_FINAL)
  })
})

describe('POST /api/admin/assistant/suggest: ticket-scoped (unified inbox §2.9)', () => {
  const ticketBody = () =>
    aguiBody({ ticketId: TICKET_ID, lastCustomerMessageId: LATEST_MESSAGE_ID })

  it('resolves the item state off the ticket ref and threads ticketId into the turn', async () => {
    const res = await handleSuggest({ request: makeRequest(ticketBody()) })
    expect(res.status).toBe(200)
    expect(mockLoadAssistantItemState).toHaveBeenCalledWith(null, TICKET_ID)
    expect(turnInput()).toMatchObject({
      conversationId: null,
      ticketId: TICKET_ID,
      role: 'suggested_reply',
      surface: 'copilot',
    })
  })

  it('409s on a ticket whose status category is closed', async () => {
    mockLoadAssistantItemState.mockResolvedValue({
      closed: true,
      latestCustomerMessageId: LATEST_MESSAGE_ID,
    })
    const res = await handleSuggest({ request: makeRequest(ticketBody()) })
    expect(res.status).toBe(409)
    expect(mockStreamAssistantTurn).not.toHaveBeenCalled()
  })

  it('404s when the ticket does not exist (or is not viewable)', async () => {
    mockTicketLookup.mockResolvedValue([])
    const res = await handleSuggest({ request: makeRequest(ticketBody()) })
    expect(res.status).toBe(404)
    expect(mockStreamAssistantTurn).not.toHaveBeenCalled()
  })
})
