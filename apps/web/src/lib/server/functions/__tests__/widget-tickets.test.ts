/**
 * Unit coverage for the widget-facing ticket fns: the isWidgetTicketsEnabled()
 * choke point, the two identity tiers (verified vs email-capture), overwrite-once
 * email capture on create, and server-side intake-field validation. The domains
 * are mocked, so this exercises the fn wiring, not the requester service (that
 * has its own real-DB suite).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

const forms = vi.hoisted(() => ({ customer: [] as unknown[] }))
vi.mock('@/lib/server/domains/settings/settings.tickets', () => ({
  getTicketForms: vi.fn(async () => forms),
}))

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
  listMyWidgetTicketsFn,
  replyToMyWidgetTicketFn,
} from '../widget-tickets'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (fn: unknown, data?: unknown) => (fn as any)(data === undefined ? undefined : { data })

beforeEach(() => {
  gate.enabled = true
  forms.customer = []
  authState.actor = {
    principalId: 'principal_1',
    principalType: 'user',
    role: null,
    segmentIds: new Set(),
  }
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
  it('passes validated customAttributes through to the service', async () => {
    forms.customer = [
      {
        key: 'severity',
        label: 'Severity',
        type: 'select',
        required: true,
        visibleToCustomer: true,
        order: 0,
        options: ['low', 'high'],
      },
    ]
    await call(createMyWidgetTicketFn, { title: 'Broken', fieldValues: { severity: 'high' } })
    expect(service.createMyTicket).toHaveBeenCalledTimes(1)
    const input = service.createMyTicket.mock.calls[0][1] as {
      customAttributes?: Record<string, unknown>
    }
    expect(input.customAttributes).toEqual({ severity: 'high' })
  })

  it('rejects invalid field values and never calls the service', async () => {
    forms.customer = [
      {
        key: 'severity',
        label: 'Severity',
        type: 'select',
        required: true,
        visibleToCustomer: true,
        order: 0,
        options: ['low', 'high'],
      },
    ]
    await expect(
      call(createMyWidgetTicketFn, { title: 'Broken', fieldValues: { severity: 'nope' } })
    ).rejects.toThrow()
    expect(service.createMyTicket).not.toHaveBeenCalled()
  })

  it('reply delegates to the requester service', async () => {
    await call(replyToMyWidgetTicketFn, { ticketId: 'ticket_1', content: 'hi' })
    expect(service.replyToMyTicket).toHaveBeenCalledTimes(1)
  })
})
