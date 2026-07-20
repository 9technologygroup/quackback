/**
 * Unit coverage for the widget-facing ticket fns: the isWidgetTicketsEnabled()
 * choke point, the two identity tiers (verified vs email-capture), overwrite-once
 * email capture on create, and server-side intake-field validation. The domains
 * are mocked, so this exercises the fn wiring, not the requester service (that
 * has its own real-DB suite).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ValidationError } from '@/lib/shared/errors'

// createServerFn wraps the handler in an RPC entry needing a request context;
// return the raw handler (supporting the .validator() chain) so it's directly
// callable here.
vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const builder: { validator: () => typeof builder; handler: (fn: unknown) => unknown } = {
      validator: () => builder,
      handler: (fn: unknown) => fn,
    }
    return builder
  },
}))

const authState = vi.hoisted(() => ({
  actor: {
    principalId: 'principal_1',
    principalType: 'user',
    role: null,
    segmentIds: new Set(),
  } as {
    principalId: string | null
    principalType: string
    role: null
    segmentIds: Set<string>
  },
}))
vi.mock('../auth-helpers', () => ({
  requireAuth: vi.fn(async () => ({ principal: { id: authState.actor.principalId } })),
  policyActorFromAuth: vi.fn(async () => authState.actor),
}))

const gate = vi.hoisted(() => ({ enabled: true }))
vi.mock('@/lib/server/domains/settings/settings.support', () => ({
  isWidgetTicketsEnabled: vi.fn(async () => gate.enabled),
}))

// Phase 4: the intake type registry (form listing + create-time resolution/
// validation). Deep validation behavior lives in the ticket-type-intake.service
// real-DB suite; here the fn wiring is what matters.
const typeSvc = vi.hoisted(() => ({
  listIntakeTypes: vi.fn(async () => [] as unknown[]),
  resolveIntakeCreate: vi.fn(
    async (..._args: unknown[]) =>
      ({ ticketTypeId: null, customAttributes: undefined }) as {
        ticketTypeId: string | null
        customAttributes: Record<string, unknown> | undefined
      }
  ),
  ticketTypeToIntakeDTO: vi.fn((t: unknown) => t),
}))
vi.mock('@/lib/server/domains/tickets/ticket-type-intake.service', () => typeSvc)

const service = vi.hoisted(() => ({
  requesterHasContactChannel: vi.fn(async () => true),
  isPlausibleContactEmail: vi.fn(
    (raw: unknown) =>
      typeof raw === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim().toLowerCase())
  ),
  captureRequesterEmail: vi.fn(async (..._args: unknown[]) => ({ captured: true })),
  createMyTicket: vi.fn(async (..._args: unknown[]) => ({ id: 'ticket_1' })),
  replyToMyTicket: vi.fn(async (..._args: unknown[]) => ({ message: { id: 'msg_1' } })),
  listMyTickets: vi.fn(async () => []),
}))
vi.mock('@/lib/server/domains/tickets/requester.service', () => service)

import {
  createMyWidgetTicketFn,
  getWidgetTicketFormFn,
  listMyWidgetTicketsFn,
  replyToMyWidgetTicketFn,
} from '../widget-tickets'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (fn: unknown, data?: unknown) => (fn as any)(data === undefined ? undefined : { data })

beforeEach(() => {
  gate.enabled = true
  authState.actor = {
    principalId: 'principal_1',
    principalType: 'user',
    role: null,
    segmentIds: new Set(),
  }
  typeSvc.listIntakeTypes.mockResolvedValue([])
  typeSvc.resolveIntakeCreate.mockResolvedValue({ ticketTypeId: null, customAttributes: undefined })
  service.requesterHasContactChannel.mockResolvedValue(true)
  service.createMyTicket.mockClear()
  service.replyToMyTicket.mockClear()
  service.captureRequesterEmail.mockClear()
})

describe('widget ticket fns — choke point', () => {
  it('rejects every path when the module is disabled', async () => {
    gate.enabled = false
    await expect(call(listMyWidgetTicketsFn)).rejects.toThrow(/not available/i)
    await expect(call(createMyWidgetTicketFn, { title: 'x' })).rejects.toThrow(/not available/i)
  })
})

describe('widget ticket fns — identity tiers', () => {
  it('an identified visitor delegates create with no email capture', async () => {
    await call(createMyWidgetTicketFn, { title: 'Broken' })
    expect(service.createMyTicket).toHaveBeenCalledTimes(1)
    expect(service.captureRequesterEmail).not.toHaveBeenCalled()
  })

  it('an anonymous visitor without an email is refused EMAIL_REQUIRED', async () => {
    authState.actor = {
      principalId: 'principal_anon',
      principalType: 'anonymous',
      role: null,
      segmentIds: new Set(),
    }
    service.requesterHasContactChannel.mockResolvedValue(false)
    await expect(call(createMyWidgetTicketFn, { title: 'Broken' })).rejects.toThrow(/email/i)
    expect(service.createMyTicket).not.toHaveBeenCalled()
  })

  it('an anonymous visitor supplying an email captures it (overwrite-once) then creates', async () => {
    authState.actor = {
      principalId: 'principal_anon',
      principalType: 'anonymous',
      role: null,
      segmentIds: new Set(),
    }
    service.requesterHasContactChannel.mockResolvedValue(false)
    await call(createMyWidgetTicketFn, { title: 'Broken', email: 'visitor@example.com' })
    expect(service.captureRequesterEmail).toHaveBeenCalledWith(
      'principal_anon',
      'visitor@example.com'
    )
    expect(service.createMyTicket).toHaveBeenCalledTimes(1)
  })

  it('an anonymous visitor with a captured email passes without supplying one', async () => {
    authState.actor = {
      principalId: 'principal_anon',
      principalType: 'anonymous',
      role: null,
      segmentIds: new Set(),
    }
    service.requesterHasContactChannel.mockResolvedValue(true)
    await call(createMyWidgetTicketFn, { title: 'Broken' })
    expect(service.captureRequesterEmail).not.toHaveBeenCalled()
    expect(service.createMyTicket).toHaveBeenCalledTimes(1)
  })
})

describe('widget ticket fns — intake validation', () => {
  it('serves the intake types (the form fn)', async () => {
    typeSvc.listIntakeTypes.mockResolvedValue([{ id: 'ticket_type_bug' }])
    const out = await call(getWidgetTicketFormFn)
    expect(typeSvc.listIntakeTypes).toHaveBeenCalledTimes(1)
    expect(out).toEqual({ types: [{ id: 'ticket_type_bug' }] })
  })

  it('delegates intake resolution and passes its result to the service', async () => {
    typeSvc.resolveIntakeCreate.mockResolvedValue({
      ticketTypeId: 'ticket_type_bug',
      customAttributes: { severity: 'high' },
    })
    await call(createMyWidgetTicketFn, {
      title: 'Broken',
      ticketTypeId: 'ticket_type_bug',
      fieldValues: { severity: 'high' },
    })
    expect(typeSvc.resolveIntakeCreate).toHaveBeenCalledWith('ticket_type_bug', {
      severity: 'high',
    })
    expect(service.createMyTicket).toHaveBeenCalledTimes(1)
    const input = service.createMyTicket.mock.calls[0][1] as {
      ticketTypeId?: string | null
      customAttributes?: Record<string, unknown>
    }
    expect(input).toMatchObject({
      ticketTypeId: 'ticket_type_bug',
      customAttributes: { severity: 'high' },
    })
  })

  it('propagates an intake validation failure and never calls the service', async () => {
    typeSvc.resolveIntakeCreate.mockRejectedValue(
      new ValidationError('INVALID_TICKET_FIELDS', 'Severity is required')
    )
    await expect(
      call(createMyWidgetTicketFn, { title: 'Broken', fieldValues: { severity: 'nope' } })
    ).rejects.toThrow(/Severity is required/)
    expect(service.createMyTicket).not.toHaveBeenCalled()
  })

  it('reply delegates to the requester service', async () => {
    await call(replyToMyWidgetTicketFn, { ticketId: 'ticket_1', content: 'hi' })
    expect(service.replyToMyTicket).toHaveBeenCalledTimes(1)
  })
})
