/**
 * A refusal the client branches on comes back as a value. A thrown error
 * reaches the client with its message only, so a code it carried would be
 * lost on the way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConflictError, ForbiddenError, ValidationError } from '@/lib/shared/errors'

// createServerFn -> directly callable fns (mirrors assistant-actions.test.ts).
vi.mock('@tanstack/react-start', () => ({
  createServerOnlyFn: <T>(fn: T) => fn,
  createServerFn: () => {
    let handler: ((args: { data: unknown }) => Promise<unknown>) | null = null
    const fn = (args: { data: unknown }) => {
      if (!handler) throw new Error('handler not registered')
      return handler(args)
    }
    fn.validator = () => fn
    fn.handler = (h: (args: { data: unknown }) => Promise<unknown>) => {
      handler = h
      return fn
    }
    return fn
  },
}))

const hoisted = vi.hoisted(() => ({
  apply: vi.fn(),
  undo: vi.fn(),
  reject: vi.fn(),
  markRead: vi.fn(),
}))

vi.mock('@/lib/server/functions/auth-helpers', () => ({
  requireAuth: async () => ({ principal: { id: 'principal_1', role: 'admin', type: 'user' } }),
  policyActorFromAuth: async () => ({ principalId: 'principal_1', principalType: 'user' }),
}))
vi.mock('@/lib/server/domains/assistant/workspace-copilot-gate', () => ({
  workspaceCopilotAvailable: vi.fn(),
  assertWorkspaceCopilotAvailable: vi.fn(),
}))
vi.mock('@/lib/server/domains/assistant/workspace-threads.service', () => ({
  createWorkspaceThread: vi.fn(),
  listWorkspaceThreads: vi.fn(),
  readWorkspaceThread: vi.fn(),
}))
vi.mock('@/lib/server/domains/assistant/workspace-settings-actions.service', () => ({
  applyWorkspaceSettingsProposal: hoisted.apply,
  undoWorkspaceSettingsProposal: hoisted.undo,
}))
vi.mock('@/lib/server/domains/assistant/approvals.service', () => ({
  rejectApproval: hoisted.reject,
}))
vi.mock('@/lib/server/domains/notifications/notification.service', () => ({
  markApprovalBellsRead: hoisted.markRead,
}))

import {
  applyWorkspaceSettingsProposalFn,
  undoWorkspaceSettingsProposalFn,
} from '../workspace-copilot'
import { markApprovalBellReadFn, rejectApprovalFn } from '../approvals'

const apply = () =>
  applyWorkspaceSettingsProposalFn({
    data: {
      pendingActionId: 'assistant_action_1',
      selectedChangeIds: ['portal.displayName'],
      contentHash: 'digest-1',
    },
  })
const undo = () =>
  undoWorkspaceSettingsProposalFn({ data: { pendingActionId: 'assistant_action_1' } })
const reject = () =>
  rejectApprovalFn({
    data: { approvalId: 'assistant_action_1', contentHash: 'digest-1', reason: 'Not now' },
  })

const REFUSALS = [
  new ConflictError('APPROVAL_CONTENT_CHANGED', 'This request changed. Review it again.'),
  new ForbiddenError('APPROVAL_ADMIN_REQUIRED', 'An admin must decide this request.'),
  new ForbiddenError('APPROVAL_SIGN_IN_REQUIRED', 'Sign in again to decide this request.'),
  new ForbiddenError('APPROVAL_SELF_DECISION', 'The requester cannot decide its own request.'),
  new ValidationError('SETTINGS_CHANGED', 'These settings changed. Ask again.'),
]

beforeEach(() => vi.clearAllMocks())

describe('approval decisions return refusals as values', () => {
  it.each(REFUSALS)('Apply returns $code', async (refusal) => {
    hoisted.apply.mockRejectedValue(refusal)
    await expect(apply()).resolves.toEqual({
      ok: false,
      code: refusal.code,
      message: refusal.message,
    })
  })

  it.each(REFUSALS)('Undo returns $code', async (refusal) => {
    hoisted.undo.mockRejectedValue(refusal)
    await expect(undo()).resolves.toEqual({
      ok: false,
      code: refusal.code,
      message: refusal.message,
    })
  })

  it.each(REFUSALS)('Reject returns $code', async (refusal) => {
    hoisted.reject.mockRejectedValue(refusal)
    await expect(reject()).resolves.toEqual({
      ok: false,
      code: refusal.code,
      message: refusal.message,
    })
  })

  it('returns the settled request when the decision lands', async () => {
    hoisted.apply.mockResolvedValue({ id: 'assistant_action_1', status: 'executed', result: {} })
    await expect(apply()).resolves.toEqual({
      ok: true,
      id: 'assistant_action_1',
      status: 'executed',
      result: {},
    })
    expect(hoisted.apply).toHaveBeenCalledWith(
      expect.anything(),
      'assistant_action_1',
      ['portal.displayName'],
      { contentHash: 'digest-1', via: 'app' }
    )
    hoisted.reject.mockResolvedValue({
      id: 'assistant_action_1',
      status: 'rejected',
      decisionReason: 'Not now',
    })
    await expect(reject()).resolves.toEqual({
      ok: true,
      id: 'assistant_action_1',
      status: 'rejected',
      decisionReason: 'Not now',
    })
  })

  it('still throws a failure nobody can act on', async () => {
    hoisted.apply.mockRejectedValue(new Error('connection reset'))
    await expect(apply()).rejects.toThrow('connection reset')
    hoisted.reject.mockRejectedValue(new Error('connection reset'))
    await expect(reject()).rejects.toThrow('connection reset')
  })
})

describe('opening the approvals queue', () => {
  it('reads the caller own approval bell and says how many it read', async () => {
    hoisted.markRead.mockResolvedValue(1)
    await expect(markApprovalBellReadFn()).resolves.toEqual({ marked: 1 })
    expect(hoisted.markRead).toHaveBeenCalledWith('principal_1')
  })
})
