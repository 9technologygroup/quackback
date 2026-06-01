/**
 * Whether the team should read as "available" to a visitor — drives the online
 * dot and copy across the chat thread, the Home greeting, and the resume card,
 * so they never contradict each other.
 *
 * A live agent always counts as available. When office hours are configured
 * (`withinOfficeHours` is non-null) the schedule also marks the team available;
 * a present agent still overrides closed hours.
 */
export function chatAvailable(agentsOnline: boolean, withinOfficeHours: boolean | null): boolean {
  return withinOfficeHours === null ? agentsOnline : withinOfficeHours || agentsOnline
}
