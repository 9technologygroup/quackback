// @vitest-environment happy-dom
/**
 * Test for VisitorMessageBubble: the "AI" chip always renders for assistant
 * (isAssistant=true) messages and never renders for non-assistant messages.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { VisitorMessageBubble } from '../message-bubble'

afterEach(cleanup)

function renderBubble(props: Parameters<typeof VisitorMessageBubble>[0]) {
  return render(
    <IntlProvider locale="en-US" messages={{}}>
      <VisitorMessageBubble {...props} />
    </IntlProvider>
  )
}

describe('VisitorMessageBubble', () => {
  it('renders the AI chip for assistant messages', () => {
    renderBubble({
      side: 'peer',
      content: 'Hello there',
      authorName: 'Quinn',
      isAssistant: true,
      time: '10:30 AM',
    })

    expect(screen.getByText(/Quinn/)).toBeInTheDocument()
    const aiBadge = screen.getByText('AI')
    expect(aiBadge).toBeInTheDocument()
    expect(aiBadge.closest('span')).toHaveClass('rounded')
  })

  it('does not render the AI chip for non-assistant peer messages', () => {
    renderBubble({
      side: 'peer',
      content: 'Hello',
      authorName: 'Agent Name',
      isAssistant: false,
      time: '10:30 AM',
    })

    const aiBadge = screen.queryByText('AI')
    expect(aiBadge).not.toBeInTheDocument()
  })

  it('renders visitor (self) messages without any assistant labels', () => {
    renderBubble({
      side: 'self',
      content: 'Hi there',
      isAssistant: false,
    })

    const aiBadge = screen.queryByText('AI')
    expect(aiBadge).not.toBeInTheDocument()
  })
})
