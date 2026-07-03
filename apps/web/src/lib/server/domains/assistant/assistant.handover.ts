/**
 * The short message Quinn posts when it hands a conversation to the team. The
 * engine decides THAT to escalate; this shapes the customer-facing handover copy
 * by office hours so the wait is honest: when open (or 24/7) we promise a prompt
 * reply and never mention hours; when closed we say the team is away, so the
 * customer isn't left expecting an instant answer.
 */
import { officeHoursSnapshot } from '@/lib/shared/office-hours'
import type { OfficeHoursSchedule } from '@/lib/shared/office-hours'

export function buildAssistantHandoverMessage(
  schedule: OfficeHoursSchedule | null | undefined,
  now: Date = new Date()
): string {
  // `withinOfficeHours` is null for a disabled (24/7) schedule → treat as open.
  const { withinOfficeHours } = officeHoursSnapshot(schedule, now)
  if (withinOfficeHours === false) {
    return "I've passed this on to our team. We're offline right now, so it may take a little longer to hear back, but someone will follow up as soon as we're back online."
  }
  return "I've connected you with our team. Someone will jump in to help you shortly."
}
