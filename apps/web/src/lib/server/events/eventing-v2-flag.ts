/**
 * Single gate for the EVENTING-V2 cutover (WO-4). While OFF (default), the
 * legacy fire-and-forget resolve+enqueue path runs and the relay is dormant —
 * zero behavior change. While ON, `processEvent` writes to the durable outbox
 * and the relay becomes the sole enqueuer.
 *
 * WO-16 replaces the env read with the DB-backed `eventingV2` feature flag
 * (default OFF via read-time spread); every caller goes through this function so
 * that swap is one edit.
 */
export function isEventingV2Enabled(): boolean {
  return process.env.EVENTING_V2_RELAY === 'true'
}
