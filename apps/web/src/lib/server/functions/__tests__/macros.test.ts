/**
 * `saveCopilotAnswerAsMacroFn` (Quinn Copilot P2-C.2): the answer card's
 * "Save as macro" row. createServerFn is stubbed to a directly-callable fn
 * (mirrors assistant-snippets.test.ts) so the real zod validator runs on each
 * call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PERMISSIONS } from '@/lib/shared/permissions'

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    let _schema: { parse: (v: unknown) => unknown } | null = null
    let _handler: ((args: { data: unknown }) => Promise<unknown>) | null = null
    const fn = async (args?: { data: unknown }) => {
      if (!_handler) throw new Error('handler not registered')
      return _handler({ data: _schema ? _schema.parse(args?.data) : args?.data })
    }
    fn.validator = (schema: { parse: (v: unknown) => unknown }) => {
      _schema = schema
      return fn
    }
    fn.handler = (h: (args: { data: unknown }) => Promise<unknown>) => {
      _handler = h
      return fn
    }
    return fn
  },
}))

const hoisted = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  createMacro: vi.fn(),
}))

vi.mock('@/lib/server/functions/auth-helpers', () => ({
  requireAuth: hoisted.requireAuth,
  policyActorFromAuth: vi.fn(),
}))
vi.mock('@/lib/server/domains/macros', () => ({
  listMacros: vi.fn(),
  getMacro: vi.fn(),
  createMacro: hoisted.createMacro,
  updateMacro: vi.fn(),
  deleteMacro: vi.fn(),
  buildMacroContext: vi.fn(),
  renderMacro: vi.fn(),
  applyMacroActions: vi.fn(),
}))

import { saveCopilotAnswerAsMacroFn } from '../macros'

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireAuth.mockResolvedValue({ principal: { id: 'principal_admin' } })
})

describe('saveCopilotAnswerAsMacroFn', () => {
  it('gates on conversation.manage (macros are team content)', async () => {
    hoisted.createMacro.mockResolvedValue({ id: 'macro_1' })
    await saveCopilotAnswerAsMacroFn({
      data: { name: 'Refund policy', body: 'Refunds within 30 days.' },
    })
    expect(hoisted.requireAuth).toHaveBeenCalledWith({
      permission: PERMISSIONS.CONVERSATION_MANAGE,
    })
  })

  it('creates a support-scoped macro with no bundled actions, attributed to the caller', async () => {
    hoisted.createMacro.mockResolvedValue({
      id: 'macro_1',
      name: 'Refund policy',
      body: 'Refunds within 30 days.',
    })

    const result = await saveCopilotAnswerAsMacroFn({
      data: { name: '  Refund policy  ', body: 'Refunds within 30 days.' },
    })

    expect(hoisted.createMacro).toHaveBeenCalledWith({
      name: 'Refund policy',
      body: 'Refunds within 30 days.',
      scope: 'support',
      actions: [],
      createdByPrincipalId: 'principal_admin',
    })
    expect(result).toEqual({
      id: 'macro_1',
      name: 'Refund policy',
      body: 'Refunds within 30 days.',
    })
  })

  it('rejects a name over 120 characters at the boundary', async () => {
    await expect(
      saveCopilotAnswerAsMacroFn({ data: { name: 'x'.repeat(121), body: 'Body.' } })
    ).rejects.toThrow()
    expect(hoisted.createMacro).not.toHaveBeenCalled()
  })

  it('rejects an empty name at the boundary', async () => {
    await expect(
      saveCopilotAnswerAsMacroFn({ data: { name: '', body: 'Body.' } })
    ).rejects.toThrow()
    expect(hoisted.createMacro).not.toHaveBeenCalled()
  })

  it('rejects a body over 8000 characters at the boundary', async () => {
    await expect(
      saveCopilotAnswerAsMacroFn({ data: { name: 'Name', body: 'x'.repeat(8001) } })
    ).rejects.toThrow()
    expect(hoisted.createMacro).not.toHaveBeenCalled()
  })

  it('propagates an auth rejection without touching the domain layer', async () => {
    hoisted.requireAuth.mockRejectedValue(new Error('Access denied'))
    await expect(
      saveCopilotAnswerAsMacroFn({ data: { name: 'Name', body: 'Body.' } })
    ).rejects.toThrow('Access denied')
    expect(hoisted.createMacro).not.toHaveBeenCalled()
  })
})
