/**
 * Unit coverage for the event -> workflow-trigger mapping (§4.6, Slice 5d-iii):
 * conversation/message events map with the right conversationId / actor / subject
 * / message; non-conversation events map to null; and the service actor is carried
 * through for the dispatcher to gate.
 */
import { describe, it, expect } from 'vitest'
import type { EventData } from '@/lib/server/events/types'
import {
  DISPATCHABLE_TRIGGER_TYPES,
  type DispatchableTriggerType,
} from '@/lib/shared/workflow-trigger-types'
import { eventToWorkflowTrigger } from '../event-trigger'

const userActor = { type: 'user' as const, principalId: 'principal_agent' }
const serviceActor = { type: 'service' as const, service: 'automation' }
const base = { id: 'evt_1', timestamp: '2026-01-05T10:00:00Z' }

describe('eventToWorkflowTrigger', () => {
  it('maps conversation.created with the visitor as the cap subject', () => {
    const event = {
      ...base,
      type: 'conversation.created',
      actor: userActor,
      data: { conversation: { id: 'conversation_1', visitorPrincipalId: 'principal_visitor' } },
    } as unknown as EventData
    expect(eventToWorkflowTrigger(event)).toEqual({
      triggerType: 'conversation.created',
      conversationId: 'conversation_1',
      actorType: 'user',
      subjectPrincipalId: 'principal_visitor',
      message: null,
    })
  })

  it('maps a visitor message with its body and the visitor subject', () => {
    const event = {
      ...base,
      type: 'message.created',
      actor: userActor,
      data: {
        message: {
          id: 'm1',
          conversationId: 'conversation_9',
          senderType: 'visitor',
          authorPrincipalId: 'principal_visitor',
          content: 'I need help',
        },
        conversation: { id: 'conversation_9' },
      },
    } as unknown as EventData
    expect(eventToWorkflowTrigger(event)).toEqual({
      triggerType: 'message.created',
      conversationId: 'conversation_9',
      actorType: 'user',
      subjectPrincipalId: 'principal_visitor',
      message: { body: 'I need help', senderType: 'visitor' },
    })
  })

  it('maps a teammate message with no cap subject', () => {
    const event = {
      ...base,
      type: 'message.created',
      actor: userActor,
      data: {
        message: {
          id: 'm2',
          conversationId: 'conversation_9',
          senderType: 'agent',
          authorPrincipalId: 'principal_agent',
          content: 'On it',
        },
        conversation: { id: 'conversation_9' },
      },
    } as unknown as EventData
    expect(eventToWorkflowTrigger(event)).toMatchObject({
      triggerType: 'message.created',
      subjectPrincipalId: null,
      message: { body: 'On it' },
    })
  })

  it('maps agent-driven conversation events (no subject, no message)', () => {
    const event = {
      ...base,
      type: 'conversation.status_changed',
      actor: userActor,
      data: {
        conversation: { id: 'conversation_3' },
        previousStatus: 'open',
        newStatus: 'snoozed',
      },
    } as unknown as EventData
    expect(eventToWorkflowTrigger(event)).toMatchObject({
      triggerType: 'conversation.status_changed',
      conversationId: 'conversation_3',
      subjectPrincipalId: null,
      message: null,
    })
  })

  it('carries a service actor through (the dispatcher gates it)', () => {
    const event = {
      ...base,
      type: 'conversation.created',
      actor: serviceActor,
      data: { conversation: { id: 'conversation_1', visitorPrincipalId: 'principal_visitor' } },
    } as unknown as EventData
    expect(eventToWorkflowTrigger(event)?.actorType).toBe('service')
  })

  it('maps assistant.handed_off truthfully as service-authored, opted out of the automated-actor gate', () => {
    const event = {
      ...base,
      type: 'assistant.handed_off',
      actor: { type: 'service' as const, principalId: 'principal_assistant' },
      data: { conversationId: 'conversation_5', reason: 'low_confidence' },
    } as unknown as EventData
    expect(eventToWorkflowTrigger(event)).toEqual({
      triggerType: 'assistant.handed_off',
      conversationId: 'conversation_5',
      actorType: 'service',
      allowServiceActor: true,
      subjectPrincipalId: null,
      message: null,
    })
  })

  it('returns null for non-conversation events', () => {
    for (const type of [
      'post.created',
      'comment.created',
      'ticket.created',
      'changelog.published',
    ]) {
      const event = { ...base, type, actor: userActor, data: {} } as unknown as EventData
      expect(eventToWorkflowTrigger(event)).toBeNull()
    }
  })
})

/**
 * DISPATCHABLE_TRIGGER_TYPES (lib/shared/workflow-trigger-types.ts) is kept in
 * sync with eventToWorkflowTrigger's switch by hand comment only. The
 * dangerous direction is an array entry with no matching switch case: that
 * lets a workflow save cleanly against a triggerType (authoring validation
 * uses the same array) which then silently never fires, since the switch's
 * default falls through to null. A compile-time tie (e.g. a `satisfies
 * Record<DispatchableTriggerType, ...>` table) isn't a good fit here without
 * restructuring eventToWorkflowTrigger into a per-type lookup: the payload
 * shape genuinely differs per case (message body/subject derivation, the
 * assistant.handed_off opt-out of the automated-actor gate, ...), so a
 * uniform mapped type would just relocate the same branching into an uglier
 * shape for no real safety gain. This is the chosen route instead: a runtime
 * check that every listed type maps to a non-null trigger from a minimal
 * synthetic event of that type, so a future array entry added without a
 * switch case fails this test immediately (returns null) rather than
 * shipping a workflow trigger type that can never fire.
 */
describe('DISPATCHABLE_TRIGGER_TYPES stays in sync with the switch', () => {
  const withData = (type: string, data: unknown): EventData =>
    ({ ...base, type, actor: userActor, data }) as unknown as EventData

  // The switch here must cover every DispatchableTriggerType (TS enforces
  // this via the function's return type), so an addition to the array with
  // no case below fails typecheck, and a case with no array entry fails here
  // at runtime instead of only living in a hand-maintained comment.
  function minimalEventFor(type: DispatchableTriggerType): EventData {
    switch (type) {
      case 'conversation.created':
        return withData(type, {
          conversation: { id: 'conversation_1', visitorPrincipalId: 'principal_visitor' },
        })
      case 'conversation.status_changed':
        return withData(type, {
          conversation: { id: 'conversation_1' },
          previousStatus: 'open',
          newStatus: 'closed',
        })
      case 'conversation.assigned':
      case 'conversation.priority_changed':
      case 'conversation.csat_submitted':
        return withData(type, { conversation: { id: 'conversation_1' } })
      case 'message.created':
      case 'message.note_created':
        return withData(type, {
          message: {
            id: 'm1',
            conversationId: 'conversation_1',
            senderType: 'agent',
            authorPrincipalId: 'principal_agent',
            content: 'hi',
          },
          conversation: { id: 'conversation_1' },
        })
      case 'assistant.handed_off':
        return withData(type, { conversationId: 'conversation_1', reason: 'low_confidence' })
    }
  }

  it.each(DISPATCHABLE_TRIGGER_TYPES)('%s maps to a non-null trigger', (type) => {
    expect(eventToWorkflowTrigger(minimalEventFor(type))).not.toBeNull()
  })
})
