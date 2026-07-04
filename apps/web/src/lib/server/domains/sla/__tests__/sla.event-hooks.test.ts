/**
 * Unit coverage for the SLA event hook (§4.6): a teammate message settles the
 * first-response clock, a close settles time-to-close, and nothing else (visitor
 * messages, non-close status changes, other events) touches the recorders. The
 * recorders themselves are covered against a real DB in sla.service.test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EventData } from '@/lib/server/events/types'

const { recordFirstResponse, recordResolution } = vi.hoisted(() => ({
  recordFirstResponse: vi.fn().mockResolvedValue(undefined),
  recordResolution: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../sla.service', () => ({ recordFirstResponse, recordResolution }))

import { recordSlaFromEvent } from '../sla.event-hooks'

const at = '2026-01-05T10:00:00Z'

beforeEach(() => vi.clearAllMocks())

describe('recordSlaFromEvent', () => {
  it('settles first response on a teammate message, at the event time', async () => {
    await recordSlaFromEvent({
      type: 'message.created',
      timestamp: at,
      data: { message: { conversationId: 'conversation_1', senderType: 'agent' } },
    } as unknown as EventData)
    expect(recordFirstResponse).toHaveBeenCalledWith('conversation_1', new Date(at))
    expect(recordResolution).not.toHaveBeenCalled()
  })

  it('ignores a visitor message', async () => {
    await recordSlaFromEvent({
      type: 'message.created',
      timestamp: at,
      data: { message: { conversationId: 'conversation_1', senderType: 'visitor' } },
    } as unknown as EventData)
    expect(recordFirstResponse).not.toHaveBeenCalled()
  })

  it('settles time-to-close when a conversation closes', async () => {
    await recordSlaFromEvent({
      type: 'conversation.status_changed',
      timestamp: at,
      data: { conversation: { id: 'conversation_2' }, newStatus: 'closed' },
    } as unknown as EventData)
    expect(recordResolution).toHaveBeenCalledWith('conversation_2', new Date(at))
  })

  it('ignores a non-close status change and unrelated events', async () => {
    await recordSlaFromEvent({
      type: 'conversation.status_changed',
      timestamp: at,
      data: { conversation: { id: 'conversation_2' }, newStatus: 'snoozed' },
    } as unknown as EventData)
    await recordSlaFromEvent({
      type: 'post.created',
      timestamp: at,
      data: {},
    } as unknown as EventData)
    expect(recordFirstResponse).not.toHaveBeenCalled()
    expect(recordResolution).not.toHaveBeenCalled()
  })
})
