// @vitest-environment happy-dom
/**
 * The uptime bar's days used to be `title` attributes on plain spans: no
 * keyboard reach, no touch, no accessible name. Each day is now a button
 * named by its date, worst status and uptime, the bar is a single tab stop
 * with arrow-key movement, and one shared tooltip follows the day in view.
 *
 * At phone width 90 days were under 3px each. Below the `sm` breakpoint the
 * bar shows the last 30: CSS hides the older days (so server rendering needs
 * no width), the labels give the range each width shows, and the keyboard
 * never lands on a hidden day.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IntlProvider } from 'react-intl'
import { StatusUptimeBar, type StatusUptimeDay } from '../status-uptime-bar'

afterEach(cleanup)

const days: StatusUptimeDay[] = [
  { date: '2026-10-01', worstStatus: 'operational', uptimePct: 100 },
  { date: '2026-10-02', worstStatus: 'partial_outage', uptimePct: 99.5 },
  { date: '2026-10-03', worstStatus: 'major_outage', uptimePct: 97.25 },
]

function renderBar(locale = 'en', messages: Record<string, string> = {}) {
  return render(
    <IntlProvider locale={locale} defaultLocale="en" messages={messages}>
      <StatusUptimeBar days={days} componentName="API" />
    </IntlProvider>
  )
}

describe('StatusUptimeBar', () => {
  it('names every day by its date, worst status and uptime', () => {
    renderBar()
    expect(screen.getByRole('group', { name: 'API uptime, last 3 days' })).toBeInTheDocument()
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Oct 1: Operational, 100%',
      'Oct 2: Partial outage, 99.5%',
      'Oct 3: Major outage, 97.25%',
    ])
  })

  it('is one tab stop, on the latest day, and arrow keys move between days', async () => {
    renderBar()
    const user = userEvent.setup()
    const buttons = screen.getAllByRole('button')
    expect(buttons.filter((b) => b.tabIndex === 0)).toEqual([buttons[2]])

    await user.tab()
    expect(buttons[2]).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(buttons[1]).toHaveFocus()
    expect(buttons[1].tabIndex).toBe(0)
    expect(buttons[2].tabIndex).toBe(-1)
    await user.keyboard('{Home}')
    expect(buttons[0]).toHaveFocus()
    await user.keyboard('{End}')
    expect(buttons[2]).toHaveFocus()
  })

  it('shows the focused day in the tooltip', async () => {
    renderBar()
    const user = userEvent.setup()
    await user.tab()
    await user.keyboard('{ArrowLeft}')
    expect(await screen.findByText('Oct 2: Partial outage, 99.5%')).toBeInTheDocument()
  })

  it('opens a day on a tap, and a tap on another day moves it there', async () => {
    renderBar()
    const user = userEvent.setup()
    const [first, second] = screen.getAllByRole('button')
    await user.pointer({ keys: '[TouchA]', target: first })
    expect(await screen.findByText('Oct 1: Operational, 100%')).toBeInTheDocument()
    await user.pointer({ keys: '[TouchA]', target: second })
    expect(await screen.findByText('Oct 2: Partial outage, 99.5%')).toBeInTheDocument()
    expect(screen.queryByText('Oct 1: Operational, 100%')).toBeNull()
  })

  it('opens a day on a click even when the press does not focus it', async () => {
    renderBar()
    const [first] = screen.getAllByRole('button')
    await act(async () => {
      fireEvent.click(first)
    })
    expect(await screen.findByText('Oct 1: Operational, 100%')).toBeInTheDocument()
  })

  it('formats uptime for the locale instead of with a fixed decimal point', () => {
    renderBar('de', {
      'portal.status.uptime.pct': '{pct} % Verfügbarkeit',
      'portal.status.uptime.dayTooltip': '{day}: {label}, {pct} %',
    })
    // (100 + 99.5 + 97.25) / 3 = 98.9166…
    expect(screen.getByText('98,92 % Verfügbarkeit')).toBeInTheDocument()
    expect(screen.getAllByRole('button')[1].getAttribute('aria-label')).toBe(
      '2. Okt.: Partial outage, 99,5 %'
    )
  })
})

/** 90 days: the 60 oldest at 99% uptime, the last 30 at 100%. */
const ninetyDays: StatusUptimeDay[] = Array.from({ length: 90 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 6, 13 + i)).toISOString().slice(0, 10),
  worstStatus: i < 60 ? 'degraded_performance' : 'operational',
  uptimePct: i < 60 ? 99 : 100,
}))

function renderNinetyDays() {
  return render(
    <IntlProvider locale="en" defaultLocale="en">
      <StatusUptimeBar days={ninetyDays} componentName="API" />
    </IntlProvider>
  )
}

function setViewportWidth(width: number) {
  ;(
    window as unknown as { happyDOM: { setViewport(viewport: { width: number }): void } }
  ).happyDOM.setViewport({ width })
}

describe('StatusUptimeBar on a small screen', () => {
  afterEach(() => setViewportWidth(1024))

  it('renders every day and hides all but the last 30 below the sm breakpoint', () => {
    renderNinetyDays()
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(90)
    for (const older of buttons.slice(0, 60)) expect(older).toHaveClass('hidden', 'sm:block')
    for (const recent of buttons.slice(60)) expect(recent).not.toHaveClass('hidden')
  })

  it('labels the range each width shows', () => {
    renderNinetyDays()
    expect(screen.getByText('30 days ago')).toHaveClass('sm:hidden')
    expect(screen.getByText('90 days ago')).toHaveClass('hidden', 'sm:inline')
    // The last 30 days alone, and all 90: (60 × 99 + 30 × 100) / 90.
    expect(screen.getByText('100.00% uptime')).toHaveClass('sm:hidden')
    expect(screen.getByText('99.33% uptime')).toHaveClass('hidden', 'sm:inline')
  })

  it('keeps the keyboard on the days a small screen shows', async () => {
    setViewportWidth(390)
    renderNinetyDays()
    expect(screen.getByRole('group', { name: 'API uptime, last 30 days' })).toBeInTheDocument()
    const user = userEvent.setup()
    const buttons = screen.getAllByRole('button')

    await user.tab()
    expect(buttons[89]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(buttons[60]).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(buttons[60]).toHaveFocus()
    await user.keyboard('{End}')
    expect(buttons[89]).toHaveFocus()
  })

  it('reaches every day on a wide screen', async () => {
    renderNinetyDays()
    expect(screen.getByRole('group', { name: 'API uptime, last 90 days' })).toBeInTheDocument()
    const user = userEvent.setup()
    const buttons = screen.getAllByRole('button')
    await user.tab()
    await user.keyboard('{Home}')
    expect(buttons[0]).toHaveFocus()
  })

  it('puts the tab stop back on the latest day when the screen narrows past it', async () => {
    renderNinetyDays()
    const user = userEvent.setup()
    const buttons = screen.getAllByRole('button')
    await user.tab()
    await user.keyboard('{Home}')
    expect(buttons[0].tabIndex).toBe(0)

    act(() => setViewportWidth(390))

    expect(buttons[0].tabIndex).toBe(-1)
    expect(buttons[89].tabIndex).toBe(0)
  })
})
