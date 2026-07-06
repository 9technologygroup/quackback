/**
 * Server-fn wiring for P2-D.1 two-way inbox translation:
 *  - sendAgentMessageFn translates an outgoing reply before sending when
 *    translation is active (and BLOCKS the send on failure, never silently
 *    sends untranslated), honors the explicit skipTranslation fallback, and
 *    is a no-op (zero behavior change) when the flag is off.
 *  - translateConversationMessagesFn / setInboxTranslationEnabledFn /
 *    dismissInboxTranslationSuggestionFn are gated the same way the sibling
 *    conversation fns already are.
 * The underlying translation logic itself is covered by
 * conversation-translation.service.test.ts; this file pins the orchestration
 * (flag checks, permission gates, and what gets passed to the service).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// createServerFn → directly-callable fns (mirrors conversation-transcript-export.test.ts).
vi.mock('@tanstack/react-start', () => ({
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
  requireAuth: vi.fn(),
  policyActorFromAuth: vi.fn(),
  isFeatureEnabled: vi.fn(),
  sendAgentMessage: vi.fn(),
  resolveOutgoingReplyTranslation: vi.fn(),
  setInboxTranslationEnabled: vi.fn(),
  dismissInboxTranslationSuggestion: vi.fn(),
  getInboxTranslationContext: vi.fn(),
  translateIncomingMessage: vi.fn(),
  assertConversationViewable: vi.fn(),
  TranslationUnavailableError: class TranslationUnavailableError extends Error {},
  log: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}))

vi.mock('@/lib/server/logger', () => {
  const child = () => ({ ...hoisted.log, child })
  return { logger: { ...hoisted.log, child }, createLogger: () => ({ ...hoisted.log, child }) }
})
vi.mock('@/lib/server/functions/auth-helpers', () => ({
  requireAuth: hoisted.requireAuth,
  policyActorFromAuth: hoisted.policyActorFromAuth,
  assertPermission: vi.fn(),
  hasAuthCredentials: vi.fn(),
  getOptionalAuth: vi.fn(),
}))
vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  isFeatureEnabled: hoisted.isFeatureEnabled,
}))
vi.mock('@/lib/server/domains/conversation/conversation.service', () => ({
  sendAgentMessage: hoisted.sendAgentMessage,
  assertConversationViewable: hoisted.assertConversationViewable,
}))
vi.mock('@/lib/server/domains/conversation/conversation-translation.service', () => ({
  resolveOutgoingReplyTranslation: hoisted.resolveOutgoingReplyTranslation,
  setInboxTranslationEnabled: hoisted.setInboxTranslationEnabled,
  dismissInboxTranslationSuggestion: hoisted.dismissInboxTranslationSuggestion,
  getInboxTranslationContext: hoisted.getInboxTranslationContext,
  translateIncomingMessage: hoisted.translateIncomingMessage,
  TranslationUnavailableError: hoisted.TranslationUnavailableError,
}))
vi.mock('@/lib/server/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/server/db')>()
  return {
    ...real,
    db: {
      query: { user: { findFirst: vi.fn(async () => ({ preferredLanguage: 'en' })) } },
      select: () => ({
        from: () => ({
          where: async () => [
            { id: 'conversation_msg_1', content: 'Bonjour', conversationId: 'conversation_1' },
          ],
        }),
      }),
    },
  }
})

import {
  sendAgentMessageFn,
  translateConversationMessagesFn,
  setInboxTranslationEnabledFn,
  dismissInboxTranslationSuggestionFn,
} from '../conversation'

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireAuth.mockResolvedValue({
    principal: { id: 'principal_agent', role: 'admin' },
    user: { id: 'user_1', name: 'Ann', image: null },
  })
  hoisted.policyActorFromAuth.mockResolvedValue({ principalId: 'principal_agent', role: 'admin' })
  hoisted.sendAgentMessage.mockResolvedValue({
    conversation: { id: 'conversation_1' },
    message: { id: 'conversation_msg_1', content: 'sent' },
  })
})

describe('sendAgentMessageFn — inbox translation wiring', () => {
  it('flag off: sends the original content untouched (zero behavior change)', async () => {
    hoisted.isFeatureEnabled.mockResolvedValue(false)

    await sendAgentMessageFn({
      data: { conversationId: 'conversation_1', content: 'Hi there', contentJson: null },
    })

    expect(hoisted.resolveOutgoingReplyTranslation).not.toHaveBeenCalled()
    expect(hoisted.sendAgentMessage).toHaveBeenCalledWith(
      'conversation_1',
      'Hi there',
      expect.any(Object),
      expect.any(Object),
      undefined,
      null,
      undefined
    )
  })

  it('flag on: translates the reply and attaches translatedFrom metadata', async () => {
    hoisted.isFeatureEnabled.mockResolvedValue(true)
    hoisted.resolveOutgoingReplyTranslation.mockResolvedValue({
      content: 'Bonjour',
      contentJson: null,
      translatedFrom: { originalContent: 'Hi there', sourceLocale: 'en', targetLocale: 'fr' },
    })

    await sendAgentMessageFn({
      data: { conversationId: 'conversation_1', content: 'Hi there', contentJson: null },
    })

    expect(hoisted.resolveOutgoingReplyTranslation).toHaveBeenCalledWith({
      conversationId: 'conversation_1',
      content: 'Hi there',
      contentJson: null,
      teammateUserId: 'user_1',
    })
    expect(hoisted.sendAgentMessage).toHaveBeenCalledWith(
      'conversation_1',
      'Bonjour',
      expect.any(Object),
      expect.any(Object),
      undefined,
      null,
      { translatedFrom: { originalContent: 'Hi there', sourceLocale: 'en', targetLocale: 'fr' } }
    )
  })

  it('translation failure BLOCKS the send (propagates, never sends untranslated)', async () => {
    hoisted.isFeatureEnabled.mockResolvedValue(true)
    hoisted.resolveOutgoingReplyTranslation.mockRejectedValue(
      new hoisted.TranslationUnavailableError('Translation is unavailable right now.')
    )

    await expect(
      sendAgentMessageFn({
        data: { conversationId: 'conversation_1', content: 'Hi there', contentJson: null },
      })
    ).rejects.toThrow('Translation is unavailable right now.')
    expect(hoisted.sendAgentMessage).not.toHaveBeenCalled()
  })

  it('skipTranslation bypasses translation entirely — the explicit "Send untranslated" fallback', async () => {
    hoisted.isFeatureEnabled.mockResolvedValue(true)

    await sendAgentMessageFn({
      data: {
        conversationId: 'conversation_1',
        content: 'Hi there',
        contentJson: null,
        skipTranslation: true,
      },
    })

    expect(hoisted.resolveOutgoingReplyTranslation).not.toHaveBeenCalled()
    expect(hoisted.sendAgentMessage).toHaveBeenCalledWith(
      'conversation_1',
      'Hi there',
      expect.any(Object),
      expect.any(Object),
      undefined,
      null,
      undefined
    )
  })
})

describe('translateConversationMessagesFn', () => {
  it('returns an empty map when the flag is off (no service calls)', async () => {
    hoisted.isFeatureEnabled.mockResolvedValue(false)
    const result = await translateConversationMessagesFn({
      data: { conversationId: 'conversation_1', messageIds: ['conversation_msg_1'] },
    })
    expect(result).toEqual({})
    expect(hoisted.getInboxTranslationContext).not.toHaveBeenCalled()
  })

  it('returns an empty map when translation is not active for the conversation', async () => {
    hoisted.isFeatureEnabled.mockResolvedValue(true)
    hoisted.assertConversationViewable.mockResolvedValue({ id: 'conversation_1' })
    hoisted.getInboxTranslationContext.mockResolvedValue({ enabled: false, customerLocale: 'fr' })

    const result = await translateConversationMessagesFn({
      data: { conversationId: 'conversation_1', messageIds: ['conversation_msg_1'] },
    })
    expect(result).toEqual({})
    expect(hoisted.translateIncomingMessage).not.toHaveBeenCalled()
  })

  it('translates the requested messages when active, keyed by message id', async () => {
    hoisted.isFeatureEnabled.mockResolvedValue(true)
    hoisted.assertConversationViewable.mockResolvedValue({ id: 'conversation_1' })
    hoisted.getInboxTranslationContext.mockResolvedValue({ enabled: true, customerLocale: 'fr' })
    hoisted.translateIncomingMessage.mockResolvedValue({ content: 'Hello', cached: false })

    const result = await translateConversationMessagesFn({
      data: { conversationId: 'conversation_1', messageIds: ['conversation_msg_1'] },
    })

    expect(result).toEqual({ conversation_msg_1: { content: 'Hello', sourceLocale: 'fr' } })
  })
})

describe('setInboxTranslationEnabledFn / dismissInboxTranslationSuggestionFn (activation persistence)', () => {
  it('setInboxTranslationEnabledFn delegates to the service with the actor', async () => {
    const actor = { principalId: 'principal_agent', role: 'admin' }
    hoisted.policyActorFromAuth.mockResolvedValue(actor)

    const result = await setInboxTranslationEnabledFn({
      data: { conversationId: 'conversation_1', enabled: true },
    })

    expect(hoisted.setInboxTranslationEnabled).toHaveBeenCalledWith('conversation_1', true, actor)
    expect(result).toEqual({ ok: true })
  })

  it('setInboxTranslationEnabledFn requires auth and propagates a denial', async () => {
    hoisted.requireAuth.mockRejectedValue(new Error('Access denied'))
    await expect(
      setInboxTranslationEnabledFn({ data: { conversationId: 'conversation_1', enabled: true } })
    ).rejects.toThrow(/access denied/i)
    expect(hoisted.setInboxTranslationEnabled).not.toHaveBeenCalled()
  })

  it('dismissInboxTranslationSuggestionFn delegates to the service with the actor', async () => {
    const actor = { principalId: 'principal_agent', role: 'admin' }
    hoisted.policyActorFromAuth.mockResolvedValue(actor)

    const result = await dismissInboxTranslationSuggestionFn({
      data: { conversationId: 'conversation_1' },
    })

    expect(hoisted.dismissInboxTranslationSuggestion).toHaveBeenCalledWith('conversation_1', actor)
    expect(result).toEqual({ ok: true })
  })
})
