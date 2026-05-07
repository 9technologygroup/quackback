/**
 * Boot lifecycle hub. Runs once per pod start, after the DB pool +
 * import-cache warmup but before the request handler accepts traffic.
 * Each handler is fire-and-forget at the orchestrator level — a
 * single bad handler must not block boot — so each handler is
 * responsible for its own try/catch internally.
 *
 * Stage 1C registers the first handler:
 *   - upsertInternalApiKey: ensures the api_keys row matching the
 *     projected INTERNAL_API_KEY env var exists in this workspace's DB.
 *
 * Future stages (3A/3B) will register additional handlers here:
 *   - pullBootConfig: fetch tierLimits + bootstrap directives from
 *     the configured QUACKBACK_CONFIG_PROVIDER_URL.
 */

import { upsertInternalApiKey } from './internal-api-key-upsert'

export async function runBootHandlers(): Promise<void> {
  await Promise.allSettled([upsertInternalApiKey()])
}
