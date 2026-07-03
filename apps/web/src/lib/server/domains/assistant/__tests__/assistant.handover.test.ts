import { describe, it, expect } from 'vitest'
import { buildAssistantHandoverMessage } from '../assistant.handover'
import type { OfficeHoursSchedule } from '@/lib/shared/office-hours'

const now = new Date('2026-01-07T12:00:00Z') // a Wednesday

describe('buildAssistantHandoverMessage', () => {
  it('promises a prompt reply and never mentions hours when open (24/7)', () => {
    const schedule: OfficeHoursSchedule = { enabled: false, timezone: 'UTC', intervals: [] }
    const msg = buildAssistantHandoverMessage(schedule, now).toLowerCase()
    expect(msg).toContain('team')
    expect(msg).not.toContain('offline')
  })

  it('is honest about the wait when the team is closed', () => {
    // An enabled schedule with no open intervals is always closed.
    const schedule: OfficeHoursSchedule = { enabled: true, timezone: 'UTC', intervals: [] }
    const msg = buildAssistantHandoverMessage(schedule, now).toLowerCase()
    expect(msg).toContain('offline')
  })
})
