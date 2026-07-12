/**
 * Single gate for the EVENTING-V2 cutover (WO-4/WO-16). While OFF (default), the
 * legacy fire-and-forget resolve+enqueue path runs and the relay is dormant —
 * zero behavior change. While ON, `processEvent` writes to the durable outbox
 * and the relay becomes the sole enqueuer.
 *
 * Two ways to enable, checked in this order:
 *  1. `EVENTING_V2_RELAY=true` env override — ops break-glass + tests that must
 *     not depend on DB settings, and a way for a worker to force the relay on
 *     without a settings round-trip.
 *  2. The DB-backed `eventingV2` feature flag (default OFF via read-time spread,
 *     toggled from the Labs "Advanced" section) — the normal rollout control.
 */
export async function isEventingV2Enabled(): Promise<boolean> {
  if (process.env.EVENTING_V2_RELAY === 'true') return true
  try {
    const { isFeatureEnabled } = await import('@/lib/server/domains/settings/settings.service')
    return await isFeatureEnabled('eventingV2')
  } catch {
    // Settings unavailable (e.g. very early boot) — fail closed to the legacy path.
    return false
  }
}
