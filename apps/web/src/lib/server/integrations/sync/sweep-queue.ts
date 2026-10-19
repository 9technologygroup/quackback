/** Imported during worker priming, before any workspace scope opens. */
import { sql } from 'drizzle-orm'
import { db } from '@/lib/server/db'
import { getExecuteRows } from '@/lib/server/utils/execute-rows'
import { dueWithin, registerWorkspaceDeadline } from '@/lib/server/jobs/deadlines'

export { sweepIntegrationSync } from './worker'

/**
 * When the recovery sweep next has anything to do: the earliest lease among
 * running syncs, or null when none is running.
 *
 * Mirrors `recoverExpiredSyncs`, which takes `state = 'running'` rows whose
 * `lease_expires_at` has passed. A workspace with no integration, or none mid
 * sync, has no running row, so its per-minute tick writes nothing.
 */
async function nextSyncLeaseExpiry(): Promise<Date | null> {
  const result = await db.execute(sql`
    SELECT min(lease_expires_at) AS due_at FROM integration_sync_operations
    WHERE state = 'running'
  `)
  const rows = getExecuteRows<{ due_at: Date | string | null }>(result)
  const value = rows[0]?.due_at ?? null
  return value === null ? null : value instanceof Date ? value : new Date(value)
}

registerWorkspaceDeadline('integration-sync-sweep', nextSyncLeaseExpiry)

/**
 * The cron gate: does a running sync's lease expire inside the next slot?
 *
 * The window is the schedule's own minute, so this can only suppress a tick
 * that would have recovered nothing; a crashed sync is still recovered within a
 * minute of its lease running out.
 */
export function isIntegrationSyncSweepDue(): Promise<boolean> {
  return dueWithin('integration-sync-sweep', 60_000)
}
