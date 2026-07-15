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
  ASSISTANT_TEST_AGENTS,
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
import type { AssistantTurnInput } from '@/lib/server/domains/assistant'

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
    agent: z.enum(ASSISTANT_TEST_AGENTS).default('agent'),
  })
  .strict()

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

/**
 * Copy only the Test agent trace contract, excluding runtime fallback detail.
 * The customer-facing role carries tone/length presets; the copilot role does
 * not (D11), so those two fields are asserted present only for
 * `customer_support` and omitted for `copilot_qa`.
 */
function toSafeTrace(trace: AssistantTurnTrace): AssistantTestTrace {
  const base = {
    promptVersion: trace.promptVersion,
    configRevision: trace.configRevision,
    appliedGuidance: trace.appliedGuidance.map(({ id, name }) => ({ id, name })),
    toolCalls: trace.toolCalls.map(({ name, outcome }) => ({ name, outcome })),
  }

  if (trace.role === 'customer_support') {
    if (!trace.tone || !trace.responseLength) {
      throw new Error('Test agent runtime returned a customer trace without presets')
    }
    return {
      ...base,
      role: 'customer_support',
      tone: trace.tone,
      responseLength: trace.responseLength,
    }
  }

  if (trace.role === 'copilot_qa') {
    return { ...base, role: 'copilot_qa' }
  }

  throw new Error(`Test agent runtime returned an unsupported role "${trace.role}"`)
}

export async function handleTestAgent({ request }: { request: Request }): Promise<Response> {
  let auth: Awaited<ReturnType<typeof requireAuth>>
  try {
    auth = await requireAuth({ permission: PERMISSIONS.ASSISTANT_MANAGE })
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

  // The discriminated turn contract forbids selecting a customer role with the
  // team surface (and vice versa), so each agent builds its own complete input.
  // Both stay `conversationId: null` + `simulate: true` — a sandbox turn that
  // never writes, never audits, and never touches the inbox.
  const common = {
    messages: parsed.messages,
    assistantPrincipalId: assistant.id,
    conversationId: null,
    simulate: true,
    signal: request.signal,
    onActivity: (activity: Parameters<NonNullable<AssistantTurnInput['onActivity']>>[0]) =>
      sse.send(ASSISTANT_TEST_EVENTS.activity, {
        status: activityToStatus(activity),
      } satisfies AssistantTestActivityPayload),
    onTextDelta: (text: string) =>
      sse.send(ASSISTANT_TEST_EVENTS.delta, { text } satisfies AssistantTestDeltaPayload),
  }
  const turnInput: AssistantTurnInput =
    parsed.agent === 'copilot'
      ? {
          ...common,
          role: 'copilot_qa',
          surface: 'copilot',
          // Attributes this test turn to the teammate running it, mirroring the
          // live copilot route.
          actorPrincipalId: auth.principal.id,
        }
      : {
          ...common,
          role: 'customer_support',
          surface: parsed.channel,
        }

  void (async () => {
    try {
      const result = await runAssistantTurn(turnInput)

      if (result.status === 'suppressed') {
        throw new Error('Test agent turn was unexpectedly suppressed')
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
