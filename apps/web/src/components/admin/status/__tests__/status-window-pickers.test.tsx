// @vitest-environment happy-dom
/**
 * An end picked before the start keeps the time the admin picked, next to the
 * "must be after the start" message. The pickers used to take the start as
 * their minimum and quietly move such an end up to the start, so the field
 * showed the start's time beside an error about a time nobody chose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/routes/admin/status', () => ({
  Route: { fullPath: '/admin/status', useSearch: () => ({}) },
}))
vi.mock('@/lib/client/mutations/status', () => ({
  useCreateStatusIncident: () => ({ mutateAsync: vi.fn(), reset: vi.fn(), isPending: false }),
}))
vi.mock('../status-incident-fields', () => ({
  AffectedComponentsField: () => null,
  TemplatePickerButton: () => null,
  templateToAffectedRows: () => [],
}))

import { ScheduleMaintenanceDialog } from '../status-schedule-maintenance-dialog'
import { ReportIncidentDialog } from '../status-report-incident-dialog'

const realTz = process.env.TZ

beforeEach(() => {
  process.env.TZ = 'UTC'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T08:00:00.000Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  process.env.TZ = realTz
})

/** Open the picker under `label` and type a time into it. */
function pickTime(label: string, time: string) {
  const field = screen.getByText(label).parentElement as HTMLElement
  fireEvent.click(within(field).getByRole('button'))
  const inputs = document.querySelectorAll<HTMLInputElement>('input[type="time"]')
  fireEvent.change(inputs[inputs.length - 1], { target: { value: time } })
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
}

function fieldText(label: string) {
  return (screen.getByText(label).parentElement as HTMLElement).textContent ?? ''
}

describe('maintenance window pickers', () => {
  it('keep an end before the start as picked, and say it must come after', () => {
    render(<ScheduleMaintenanceDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Schedule maintenance' }))

    pickTime('Scheduled start', '12:00')
    pickTime('Scheduled end', '10:00')

    expect(fieldText('Scheduled start')).toContain('12:00')
    expect(fieldText('Scheduled end')).toContain('10:00')
    expect(fieldText('Scheduled end')).not.toContain('12:00')
    expect(screen.getByText('The end must be after the start.')).toBeInTheDocument()
  })
})

describe('past incident pickers', () => {
  it('keep a resolve time before the start as picked, and say it must come after', () => {
    render(<ReportIncidentDialog />)
    fireEvent.click(screen.getByRole('button', { name: /Report incident/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Log a past incident instead' }))

    pickTime('Started at', '06:00')
    pickTime('Resolved at', '05:00')

    expect(fieldText('Started at')).toContain('06:00')
    expect(fieldText('Resolved at')).toContain('05:00')
    expect(screen.getByText('It must be resolved after it started.')).toBeInTheDocument()
  })
})
