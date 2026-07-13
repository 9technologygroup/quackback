import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import {
  activityToStatus,
  ensureAssistantPrincipal,
  isAssistantConfigured,
  runAssistantTurn,
  type AssistantTurnTrace,
} from '@/lib/server/domains/assistant'
import { enforceAiTokenBudget } from '@/lib/server/domains/settings/tier-enforce'
import { TierLimitError } from '@/lib/server/errors/tier-limit-error'
import { requireAuth } from '@/lib/server/functions/auth-helpers'
import { isAuthDenialError } from '@/lib/server/functions/auth-errors'
import { logger } from '@/lib/server/logger'
import { createSseStream, SSE_RESPONSE_HEADERS } from '@/lib/server/utils/sse'
import { PERMISSIONS } from '@/lib/shared/permissions'
import {
  ASSISTANT_TEST_CHANNELS,
  ASSISTANT_TEST_EVENTS,
  ASSISTANT_TEST_MAX_CONTENT_CHARS,
  ASSISTANT_TEST_MAX_MESSAGES,
  type AssistantTestActivityPayload,
  type AssistantTestCitation,
  type AssistantTestDeltaPayload,
  type AssistantTestErrorPayload,
  type AssistantTestFinalPayload,
  type AssistantTestTrace,
} from '@/lib/shared/assistant/test-agent-contract'

const log = logger.child({ component: 'assistant-test' })

const requestSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            sender: z.enum(['customer', 'assistant']),
            content: z.string().trim().min(1).max(ASSISTANT_TEST_MAX_CONTENT_CHARS),
          })
          .strict()
      )
      .min(1)
      .max(ASSISTANT_TEST_MAX_MESSAGES)
      .refine((messages) => messages.at(-1)?.sender === 'customer', {
        message: 'The final message must be from the customer',
      }),
    channel: z.enum(ASSISTANT_TEST_CHANNELS).default('widget'),
  })
  .strict()

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

/** Copy only the Test agent trace contract, excluding runtime fallback detail. */
function toSafeTrace(trace: AssistantTurnTrace): AssistantTestTrace {
  if (trace.role !== 'customer_support' || !trace.tone || !trace.responseLength) {
    throw new Error('Test agent runtime returned a non-customer trace')
  }

  return {
    promptVersion: trace.promptVersion,
    configRevision: trace.configRevision,
    role: 'customer_support',
    tone: trace.tone,
    responseLength: trace.responseLength,
    appliedGuidance: trace.appliedGuidance.map(({ id, name }) => ({ id, name })),
    toolCalls: trace.toolCalls.map(({ name, outcome }) => ({ name, outcome })),
  }
}

export async function handleTestAgent({ request }: { request: Request }): Promise<Response> {
  try {
    await requireAuth({ permission: PERMISSIONS.ASSISTANT_MANAGE })
  } catch (error) {
    if (!isAuthDenialError(error)) throw error
    return jsonError(403, 'FORBIDDEN', 'Assistant management access required')
  }

  let parsed: z.infer<typeof requestSchema>
  try {
    parsed = requestSchema.parse(await request.json())
  } catch {
    return jsonError(400, 'INVALID_REQUEST', 'A valid customer conversation is required')
  }

  if (!isAssistantConfigured()) {
    return jsonError(503, 'AI_NOT_CONFIGURED', 'The assistant is not configured')
  }

  try {
    await enforceAiTokenBudget()
  } catch (error) {
    if (error instanceof TierLimitError) {
      return Response.json(error.toResponseBody(), { status: error.statusCode })
    }
    throw error
  }

  const assistant = await ensureAssistantPrincipal()
  const sse = createSseStream()

  void (async () => {
    try {
      const result = await runAssistantTurn({
        messages: parsed.messages,
        assistantPrincipalId: assistant.id,
        role: 'customer_support',
        conversationId: null,
        surface: parsed.channel,
        simulate: true,
        signal: request.signal,
        onActivity: (activity) =>
          sse.send(ASSISTANT_TEST_EVENTS.activity, {
            status: activityToStatus(activity),
          } satisfies AssistantTestActivityPayload),
        onTextDelta: (text) =>
          sse.send(ASSISTANT_TEST_EVENTS.delta, { text } satisfies AssistantTestDeltaPayload),
      })

      if (result.status === 'suppressed') {
        throw new Error('Test agent customer turn was unexpectedly suppressed')
      }

      const citations: AssistantTestCitation[] = result.citations.map(
        ({ type, id, title, url }) => ({ type, id, title, url })
      )
      sse.send(ASSISTANT_TEST_EVENTS.final, {
        text: result.text,
        citations,
        escalation: result.escalation
          ? { reason: result.escalation.reason, mode: 'handoff' }
          : null,
        trace: toSafeTrace(result.trace),
      } satisfies AssistantTestFinalPayload)
    } catch (error) {
      if (!request.signal.aborted) {
        log.error({ err: error }, 'assistant test turn failed')
        sse.send(ASSISTANT_TEST_EVENTS.error, {
          code: 'TURN_FAILED',
          message: 'The test run failed',
        } satisfies AssistantTestErrorPayload)
      }
    } finally {
      sse.close()
    }
  })()

  return new Response(sse.stream, { headers: SSE_RESPONSE_HEADERS })
}

export const Route = createFileRoute('/api/admin/assistant/test')({
  server: {
    handlers: {
      POST: handleTestAgent,
    },
  },
})
