// @vitest-environment happy-dom
/**
 * The active-incident card's excerpt of the latest update ran its lines
 * together: update bodies are plain text typed into a textarea, and the
 * excerpt collapsed their line breaks. It keeps them now, inside the same
 * two-line clamp.
 */
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import type { StatusIncidentId } from '@quackback/ids'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}))

const { StatusIncidentCard } = await import('../status-incident-card')

afterEach(cleanup)

function renderCard() {
  return render(
    <IntlProvider locale="en" defaultLocale="en">
      <StatusIncidentCard
        incident={{
          id: 'status_incident_1' as StatusIncidentId,
          title: 'API errors',
          status: 'identified',
          impact: 'major',
          affectedComponents: [],
          updates: [
            { id: 'u1', body: 'Older update', createdAt: '2026-10-10T10:00:00.000Z' },
            {
              id: 'u2',
              body: 'We found the cause.\nA fix is rolling out.',
              createdAt: '2026-10-10T11:00:00.000Z',
            },
          ],
        }}
      />
    </IntlProvider>
  )
}

it("keeps the latest update's line breaks, within the two-line clamp", () => {
  renderCard()
  const excerpt = screen.getByText(
    (_, el) => el?.tagName === 'P' && /found the cause/.test(el.textContent ?? '')
  )
  expect(excerpt.textContent).toBe('We found the cause.\nA fix is rolling out.')
  expect(excerpt).toHaveClass('whitespace-pre-line', 'line-clamp-2')
  expect(screen.queryByText('Older update')).toBeNull()
})
