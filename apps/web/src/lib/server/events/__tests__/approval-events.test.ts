import { describe, expect, it } from 'vitest'
import { getEventDefinition, webhookEventTypes } from '../catalogue'
import { WEBHOOK_EVENTS } from '../integrations/webhook/constants'

const APPROVAL_EVENTS = ['approval.requested', 'approval.decided', 'approval.applied'] as const

describe('approval events', () => {
  it('are declared on the pending action and exposed to webhooks', () => {
    for (const type of APPROVAL_EVENTS) {
      const def = getEventDefinition(type)
      expect(def?.entity, type).toBe('assistant_action')
      expect(def?.exposure.webhook, type).toBe(true)
      expect(webhookEventTypes()).toContain(type)
      // A webhook can subscribe to it, over the app and the REST API alike.
      expect(WEBHOOK_EVENTS as readonly string[]).toContain(type)
    }
    expect(getEventDefinition('approval.requested')?.exposure.notification).toBe(
      'approval_requested'
    )
  })

  it('carry the decision and its reason, never the requested content', () => {
    const decided = getEventDefinition('approval.decided')!.payload
    expect(() =>
      decided.parse({
        approvalId: 'assistant_action_1',
        toolName: 'propose_settings_change',
        summary: 'Turn on Messenger',
        risk: 'medium',
        decision: 'rejected',
        decidedById: 'principal_1',
        decidedVia: 'app',
        reason: 'Not now',
      })
    ).not.toThrow()
    expect(() =>
      decided.parse({
        approvalId: 'assistant_action_1',
        toolName: 'propose_settings_change',
        summary: 'Turn on Messenger',
        risk: 'urgent',
        decision: 'approved',
        decidedById: 'principal_1',
        decidedVia: 'app',
      })
    ).toThrow()
  })
})
