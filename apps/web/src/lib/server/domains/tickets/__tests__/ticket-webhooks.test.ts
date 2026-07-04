import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Ticket } from '@/lib/server/db'
import type { Actor } from '@/lib/server/policy/types'

const dispatch = vi.hoisted(() => ({
  dispatchTicketCreated: vi.fn().mockResolvedValue(undefined),
  dispatchTicketStatusChanged: vi.fn().mockResolvedValue(undefined),
  dispatchTicketAssigned: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/server/events/dispatch', () => dispatch)

import { emitTicketCreated, emitTicketStatusChanged, emitTicketAssigned } from '../ticket.webhooks'

const now = new Date('2026-07-04T00:00:00.000Z')
const baseTicket = {
  id: 'ticket_1',
  number: 42,
  type: 'customer',
  title: 'Cannot log in',
  statusId: 'ticket_status_1',
  priority: 'high',
  requesterPrincipalId: 'principal_r',
  assigneePrincipalId: null,
  assigneeTeamId: null,
  companyId: 'company_1',
  firstResponseAt: null,
  dueAt: null,
  resolvedAt: null,
  reopenedCount: 0,
  customAttributes: {},
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
} as unknown as Ticket

const agentActor: Actor = {
  principalId: 'principal_a',
  role: 'member',
  principalType: 'user',
  segmentIds: new Set(),
} as unknown as Actor

beforeEach(() => Object.values(dispatch).forEach((m) => m.mockClear()))

describe('ticket.webhooks emit helpers', () => {
  it('emitTicketCreated sends EventTicketData with a user actor + status category + stage', async () => {
    await emitTicketCreated(agentActor, baseTicket, { category: 'open', stage: 'received' })
    expect(dispatch.dispatchTicketCreated).toHaveBeenCalledTimes(1)
    const [actorArg, dataArg] = dispatch.dispatchTicketCreated.mock.calls[0]
    expect(actorArg).toMatchObject({ type: 'user', principalId: 'principal_a' })
    expect(dataArg).toMatchObject({
      id: 'ticket_1',
      number: 42,
      type: 'customer',
      title: 'Cannot log in',
      status: 'open',
      stage: 'received',
      priority: 'high',
      requesterPrincipalId: 'principal_r',
      companyId: 'company_1',
      createdAt: '2026-07-04T00:00:00.000Z',
      resolvedAt: null,
    })
  })

  it('emitTicketCreated with a service actor carries a service actor type', async () => {
    const serviceActor = { ...agentActor, principalType: 'service' } as unknown as Actor
    await emitTicketCreated(serviceActor, baseTicket, { category: 'open', stage: null })
    const [actorArg, dataArg] = dispatch.dispatchTicketCreated.mock.calls[0]
    expect(actorArg).toMatchObject({ type: 'service', principalId: 'principal_a' })
    expect(dataArg.stage).toBeNull()
  })

  it('emitTicketStatusChanged passes previous then new category + the new stage', async () => {
    await emitTicketStatusChanged(agentActor, baseTicket, 'open', 'closed', 'resolved')
    expect(dispatch.dispatchTicketStatusChanged).toHaveBeenCalledTimes(1)
    const [, ref, previousStatus, newStatus, stage] =
      dispatch.dispatchTicketStatusChanged.mock.calls[0]
    expect(ref).toEqual({
      id: 'ticket_1',
      number: 42,
      type: 'customer',
      priority: 'high',
      assignedPrincipalId: null,
      assignedTeamId: null,
    })
    expect(previousStatus).toBe('open')
    expect(newStatus).toBe('closed')
    expect(stage).toBe('resolved')
  })

  it('emitTicketAssigned reports the ticket assignee as new and passes the previous', async () => {
    const assigned = {
      ...baseTicket,
      assigneePrincipalId: 'principal_a',
      assigneeTeamId: 'team_1',
    } as unknown as Ticket
    await emitTicketAssigned(agentActor, assigned, null, null)
    const [, ref, assignedPrincipalId, previousPrincipalId, assignedTeamId, previousTeamId] =
      dispatch.dispatchTicketAssigned.mock.calls[0]
    expect(ref).toMatchObject({ assignedPrincipalId: 'principal_a', assignedTeamId: 'team_1' })
    expect(assignedPrincipalId).toBe('principal_a')
    expect(previousPrincipalId).toBeNull()
    expect(assignedTeamId).toBe('team_1')
    expect(previousTeamId).toBeNull()
  })
})
