/**
 * Unit coverage for the dispatcher flow (§4.6, Slice 5d-ii): the human-actor gate,
 * customer_facing exclusivity (first match wins, skip when already locked), and
 * background parallelism + frequency caps. Every IO dependency is mocked so this
 * pins orchestration only; the guards are tested against a real DB separately.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ConversationId } from '@quackback/ids'

const {
  listLiveWorkflowsForTrigger,
  resolveConditionContext,
  runWorkflow,
  frequencyCapAllows,
  hasActiveCustomerFacingRun,
} = vi.hoisted(() => ({
  listLiveWorkflowsForTrigger: vi.fn(),
  resolveConditionContext: vi.fn(),
  runWorkflow: vi.fn(),
  frequencyCapAllows: vi.fn(),
  hasActiveCustomerFacingRun: vi.fn(),
}))
vi.mock('../workflow.service', () => ({ listLiveWorkflowsForTrigger }))
vi.mock('../condition.context', () => ({ resolveConditionContext }))
vi.mock('../workflow.engine', () => ({ runWorkflow }))
// channelAllows is left real (pure, no IO) so these tests exercise the actual
// channel-scoping logic; only the DB-backed guards are mocked.
vi.mock('../dispatcher.guards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dispatcher.guards')>()),
  frequencyCapAllows,
  hasActiveCustomerFacingRun,
}))

import { dispatchWorkflowTrigger, type WorkflowTrigger } from '../dispatcher'

const conversationId = 'conversation_1' as ConversationId
const wf = (
  id: string,
  cls: 'customer_facing' | 'background',
  triggerSettings: Record<string, unknown> = {}
) => ({ id, class: cls, triggerSettings }) as never
const trigger = (over: Partial<WorkflowTrigger> = {}): WorkflowTrigger => ({
  triggerType: 'conversation.created',
  conversationId,
  actorType: 'user',
  subjectPrincipalId: null,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  resolveConditionContext.mockResolvedValue({ conversation: {} })
  frequencyCapAllows.mockResolvedValue(true)
  hasActiveCustomerFacingRun.mockResolvedValue(false)
  runWorkflow.mockResolvedValue({ id: 'run_1' }) // matched + ran
})

const ranIds = () => runWorkflow.mock.calls.map((c) => (c[0] as { id: string }).id)

describe('dispatchWorkflowTrigger', () => {
  it('gates out an automated (service) actor before any load', async () => {
    await dispatchWorkflowTrigger(trigger({ actorType: 'service' }))
    expect(listLiveWorkflowsForTrigger).not.toHaveBeenCalled()
    expect(runWorkflow).not.toHaveBeenCalled()
  })

  it('lets a service actor through when the trigger explicitly opts out of the gate', async () => {
    listLiveWorkflowsForTrigger.mockResolvedValue([wf('bg1', 'background')])
    await dispatchWorkflowTrigger(trigger({ actorType: 'service', allowServiceActor: true }))
    expect(ranIds()).toEqual(['bg1'])
  })

  it('does nothing when no workflow is live for the trigger', async () => {
    listLiveWorkflowsForTrigger.mockResolvedValue([])
    await dispatchWorkflowTrigger(trigger())
    expect(runWorkflow).not.toHaveBeenCalled()
  })

  it('customer_facing is exclusive: the first that runs wins, the rest are skipped', async () => {
    listLiveWorkflowsForTrigger.mockResolvedValue([
      wf('cf1', 'customer_facing'),
      wf('cf2', 'customer_facing'),
      wf('cf3', 'customer_facing'),
    ])
    await dispatchWorkflowTrigger(trigger())
    expect(ranIds()).toEqual(['cf1']) // cf1 ran (truthy) -> break
  })

  it('customer_facing falls through a non-matching workflow to the next', async () => {
    listLiveWorkflowsForTrigger.mockResolvedValue([
      wf('cf1', 'customer_facing'),
      wf('cf2', 'customer_facing'),
      wf('cf3', 'customer_facing'),
    ])
    runWorkflow.mockResolvedValueOnce(null) // cf1 matches nothing
    await dispatchWorkflowTrigger(trigger())
    expect(ranIds()).toEqual(['cf1', 'cf2']) // tried cf1 (null), cf2 ran -> break, cf3 skipped
  })

  it('starts no customer_facing workflow when one is already locked on the conversation', async () => {
    hasActiveCustomerFacingRun.mockResolvedValue(true)
    listLiveWorkflowsForTrigger.mockResolvedValue([wf('cf1', 'customer_facing')])
    await dispatchWorkflowTrigger(trigger())
    expect(runWorkflow).not.toHaveBeenCalled()
  })

  it('runs every background workflow in parallel, and both classes together', async () => {
    listLiveWorkflowsForTrigger.mockResolvedValue([
      wf('cf1', 'customer_facing'),
      wf('bg1', 'background'),
      wf('bg2', 'background'),
    ])
    await dispatchWorkflowTrigger(trigger())
    expect(ranIds().sort()).toEqual(['bg1', 'bg2', 'cf1'])
  })

  it('skips a workflow whose frequency cap is exhausted', async () => {
    listLiveWorkflowsForTrigger.mockResolvedValue([
      wf('bg1', 'background'),
      wf('bg2', 'background'),
    ])
    frequencyCapAllows.mockImplementation(async (w: { id: string }) => w.id !== 'bg1')
    await dispatchWorkflowTrigger(trigger({ subjectPrincipalId: 'principal_x' as never }))
    expect(ranIds()).toEqual(['bg2'])
  })

  it('a channel-scoped customer_facing workflow does not run for a non-matching channel, and is never matched (the exclusive slot passes to the next)', async () => {
    resolveConditionContext.mockResolvedValue({ conversation: { channel: 'email' } })
    listLiveWorkflowsForTrigger.mockResolvedValue([
      wf('cf1', 'customer_facing', { channels: ['messenger'] }),
      wf('cf2', 'customer_facing'),
    ])
    await dispatchWorkflowTrigger(trigger())
    expect(ranIds()).toEqual(['cf2']) // cf1 is channel-excluded, never counts as tried
  })

  it('a customer_facing workflow with empty channels runs for any channel', async () => {
    resolveConditionContext.mockResolvedValue({ conversation: { channel: 'email' } })
    listLiveWorkflowsForTrigger.mockResolvedValue([wf('cf1', 'customer_facing', { channels: [] })])
    await dispatchWorkflowTrigger(trigger())
    expect(ranIds()).toEqual(['cf1'])
  })

  it('a channel-scoped background workflow does not run for a non-matching channel; a matching one does', async () => {
    resolveConditionContext.mockResolvedValue({ conversation: { channel: 'email' } })
    listLiveWorkflowsForTrigger.mockResolvedValue([
      wf('bg1', 'background', { channels: ['messenger'] }),
      wf('bg2', 'background', { channels: ['email'] }),
    ])
    await dispatchWorkflowTrigger(trigger())
    expect(ranIds()).toEqual(['bg2'])
  })

  it('a background workflow throwing does not reject the batch or lose a sibling run that already committed', async () => {
    listLiveWorkflowsForTrigger.mockResolvedValue([
      wf('bg1', 'background'),
      wf('bg2', 'background'),
    ])
    runWorkflow.mockImplementation(async (w: { id: string }) => {
      if (w.id === 'bg2') throw new Error('transient redis error scheduling wait')
      return { id: 'run_1' }
    })
    await expect(dispatchWorkflowTrigger(trigger())).resolves.toBeUndefined()
    expect(ranIds()).toEqual(['bg1', 'bg2']) // both were attempted; bg1's run stands
  })

  it('a failure before any run starts (condition resolution) still propagates for a clean retry', async () => {
    listLiveWorkflowsForTrigger.mockResolvedValue([wf('bg1', 'background')])
    resolveConditionContext.mockRejectedValue(new Error('db unavailable'))
    await expect(dispatchWorkflowTrigger(trigger())).rejects.toThrow('db unavailable')
    expect(runWorkflow).not.toHaveBeenCalled()
  })
})
