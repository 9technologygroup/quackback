/**
 * Coverage for dispatchWorkflowsForEvent's interrupt-then-dispatch ordering
 * (§4.6): a reply or close interrupts pending waits BEFORE new workflows start;
 * other events don't interrupt. The dispatcher + engine are mocked so this pins
 * only the ordering + gating.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EventData } from '@/lib/server/events/types'

const { dispatchWorkflowTrigger, interruptWaitingRuns } = vi.hoisted(() => ({
  dispatchWorkflowTrigger: vi.fn(),
  interruptWaitingRuns: vi.fn(),
}))
vi.mock('../dispatcher', () => ({ dispatchWorkflowTrigger }))
vi.mock('../workflow.engine', () => ({ interruptWaitingRuns }))

import { dispatchWorkflowsForEvent } from '../event-trigger'

const order: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  order.length = 0
  interruptWaitingRuns.mockImplementation(async () => {
    order.push('interrupt')
  })
  dispatchWorkflowTrigger.mockImplementation(async () => {
    order.push('dispatch')
  })
})

const base = { id: 'evt', timestamp: '2026-01-05T10:00:00Z', actor: { type: 'user' as const } }

describe('dispatchWorkflowsForEvent', () => {
  it('interrupts pending waits before dispatching on a message (reply)', async () => {
    await dispatchWorkflowsForEvent({
      ...base,
      type: 'message.created',
      data: { message: { conversationId: 'conversation_1', senderType: 'visitor', content: 'hi' } },
    } as unknown as EventData)
    expect(interruptWaitingRuns).toHaveBeenCalledWith('conversation_1')
    expect(order).toEqual(['interrupt', 'dispatch']) // interrupt strictly first
  })

  it('interrupts on a close', async () => {
    await dispatchWorkflowsForEvent({
      ...base,
      type: 'conversation.status_changed',
      data: { conversation: { id: 'conversation_2' }, newStatus: 'closed' },
    } as unknown as EventData)
    expect(interruptWaitingRuns).toHaveBeenCalledWith('conversation_2')
    expect(order).toEqual(['interrupt', 'dispatch'])
  })

  it('does NOT interrupt on a non-close status change or other events', async () => {
    await dispatchWorkflowsForEvent({
      ...base,
      type: 'conversation.status_changed',
      data: { conversation: { id: 'conversation_3' }, newStatus: 'snoozed' },
    } as unknown as EventData)
    await dispatchWorkflowsForEvent({
      ...base,
      type: 'conversation.assigned',
      data: { conversation: { id: 'conversation_3' } },
    } as unknown as EventData)
    expect(interruptWaitingRuns).not.toHaveBeenCalled()
    expect(dispatchWorkflowTrigger).toHaveBeenCalledTimes(2)
  })

  it('dispatches assistant.handed_off (service-authored) without interrupting waits', async () => {
    await dispatchWorkflowsForEvent({
      ...base,
      type: 'assistant.handed_off',
      actor: { type: 'service' as const, principalId: 'principal_assistant' },
      data: { conversationId: 'conversation_4', reason: 'frustration' },
    } as unknown as EventData)
    expect(interruptWaitingRuns).not.toHaveBeenCalled()
    expect(dispatchWorkflowTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerType: 'assistant.handed_off',
        conversationId: 'conversation_4',
        actorType: 'service',
        allowServiceActor: true,
      })
    )
  })

  it('does nothing for a non-conversation event (no trigger, no interrupt)', async () => {
    await dispatchWorkflowsForEvent({
      ...base,
      type: 'post.created',
      data: {},
    } as unknown as EventData)
    expect(interruptWaitingRuns).not.toHaveBeenCalled()
    expect(dispatchWorkflowTrigger).not.toHaveBeenCalled()
  })
})
