// @vitest-environment happy-dom
/**
 * AgentMessageBubble's P2-D.1 inbox-translation display: absent `translation`
 * prop is a pure pin (zero behavior change when the feature is inactive);
 * present, it renders the translated text by default with a "Show original"
 * toggle, flips to the original on click, and reads "Show translation" once
 * showing the original.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { AgentMessageBubble } from '../message-bubble'
import type { AgentConversationMessageDTO } from '@/lib/shared/conversation/types'

afterEach(cleanup)

function baseMessage(over: Partial<AgentConversationMessageDTO> = {}): AgentConversationMessageDTO {
  return {
    id: 'conversation_msg_1' as AgentConversationMessageDTO['id'],
    conversationId: 'conversation_1' as AgentConversationMessageDTO['conversationId'],
    ticketId: null,
    senderType: 'visitor',
    content: 'Bonjour, mon colis est en retard.',
    createdAt: '2026-07-01T00:00:00.000Z',
    author: { principalId: 'principal_v' as never, displayName: 'Vic', avatarUrl: null },
    attachments: [],
    citations: [],
    isAssistant: false,
    isInternal: false,
    contentJson: null,
    viaEmail: false,
    systemEvent: null,
    reactions: [],
    flaggedAt: null,
    postSuggestion: null,
    translatedFrom: null,
    ...over,
  }
}

describe('AgentMessageBubble — inbox translation (P2-D.1)', () => {
  it('renders the plain content with no toggle when translation is absent (pin: unchanged default)', () => {
    render(<AgentMessageBubble message={baseMessage()} />)
    expect(screen.getByText('Bonjour, mon colis est en retard.')).toBeInTheDocument()
    expect(screen.queryByText(/Translated from/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Show original/)).not.toBeInTheDocument()
  })

  it('shows the translated text by default with a "Translated from … Show original" toggle', () => {
    const onToggleOriginal = () => {}
    render(
      <AgentMessageBubble
        message={baseMessage()}
        translation={{
          label: 'Translated from French',
          translatedContent: 'Hello, my package is late.',
          originalContent: 'Bonjour, mon colis est en retard.',
          showingOriginal: false,
          onToggleOriginal,
        }}
      />
    )
    expect(screen.getByText('Hello, my package is late.')).toBeInTheDocument()
    expect(screen.queryByText('Bonjour, mon colis est en retard.')).not.toBeInTheDocument()
    expect(screen.getByText('Translated from French · Show original')).toBeInTheDocument()
  })

  it('clicking the toggle calls onToggleOriginal', () => {
    let toggled = false
    render(
      <AgentMessageBubble
        message={baseMessage()}
        translation={{
          label: 'Translated from French',
          translatedContent: 'Hello, my package is late.',
          originalContent: 'Bonjour, mon colis est en retard.',
          showingOriginal: false,
          onToggleOriginal: () => {
            toggled = true
          },
        }}
      />
    )
    fireEvent.click(screen.getByText('Translated from French · Show original'))
    expect(toggled).toBe(true)
  })

  it('shows the original content and "Show translation" once toggled', () => {
    render(
      <AgentMessageBubble
        message={baseMessage()}
        translation={{
          label: 'Translated from French',
          translatedContent: 'Hello, my package is late.',
          originalContent: 'Bonjour, mon colis est en retard.',
          showingOriginal: true,
          onToggleOriginal: () => {},
        }}
      />
    )
    expect(screen.getByText('Bonjour, mon colis est en retard.')).toBeInTheDocument()
    expect(screen.queryByText('Hello, my package is late.')).not.toBeInTheDocument()
    expect(screen.getByText('Show translation')).toBeInTheDocument()
  })

  it('renders an outgoing translated reply\'s "Translated to …" toggle', () => {
    render(
      <AgentMessageBubble
        message={baseMessage({ senderType: 'agent', content: 'Bonjour, comment puis-je aider?' })}
        translation={{
          label: 'Translated to French',
          translatedContent: 'Bonjour, comment puis-je aider?',
          originalContent: 'Hi, how can I help?',
          showingOriginal: false,
          onToggleOriginal: () => {},
        }}
      />
    )
    expect(screen.getByText('Bonjour, comment puis-je aider?')).toBeInTheDocument()
    expect(screen.getByText('Translated to French · Show original')).toBeInTheDocument()
  })
})
