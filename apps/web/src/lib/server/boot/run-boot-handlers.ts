/**
 * Boot lifecycle hub. Runs once per pod start, after the DB pool +
 * import-cache warmup. Each handler is fire-and-forget at the
 * orchestrator level — a single bad handler must not block boot — so
 * each handler is responsible for its own try/catch internally.
 *
 * Registered handlers:
 *   - upsertInternalApiKey (Stage 1B/1C): ensures the api_keys row
 *     matching the projected INTERNAL_API_KEY env var exists. CP needs
 *     this row to exist before it can authenticate its tier-sync push
 *     at /api/v1/internal/tier-limits.
 *
 * Tier-limits delivery itself is intentionally NOT a boot handler.
 * CP's existing tier-sync queue pushes via the internal API once the
 * pod is healthy — same path Stripe webhooks use for plan changes.
 * No boot-time HTTP call, no env-var injection, no new endpoint.
 */

import { upsertInternalApiKey } from './internal-api-key-upsert'

export async function runBootHandlers(): Promise<void> {
  await Promise.allSettled([upsertInternalApiKey()])
}
