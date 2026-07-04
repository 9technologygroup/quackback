/**
 * SLA reporting (support platform §4.6, §7). Read-only aggregates over the
 * append-only sla_events ledger — the attainment metric the support dashboard
 * shows. Counts met vs breached for each tracked clock over a date range;
 * attainment is met / (met + breached), null when nothing was recorded.
 */
import { db, and, gte, lt, count, slaEvents } from '@/lib/server/db'

export interface ClockAttainment {
  met: number
  breached: number
  /** met / (met + breached), or null when no events fell in the range. */
  rate: number | null
}

export interface SlaAttainment {
  firstResponse: ClockAttainment
  resolution: ClockAttainment
}

function attainment(met: number, breached: number): ClockAttainment {
  const total = met + breached
  return { met, breached, rate: total === 0 ? null : met / total }
}

/** SLA attainment over [from, to). */
export async function slaAttainment(from: Date, to: Date): Promise<SlaAttainment> {
  const rows = await db
    .select({ kind: slaEvents.kind, n: count() })
    .from(slaEvents)
    .where(and(gte(slaEvents.at, from), lt(slaEvents.at, to)))
    .groupBy(slaEvents.kind)

  const n = (kind: string): number => rows.find((r) => r.kind === kind)?.n ?? 0
  return {
    firstResponse: attainment(n('first_response_met'), n('first_response_breached')),
    resolution: attainment(n('resolution_met'), n('resolution_breached')),
  }
}
