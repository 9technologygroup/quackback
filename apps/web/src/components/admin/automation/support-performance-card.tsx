/**
 * Workflow & SLA performance (§4.6, §7). A compact read-only view of SLA
 * attainment + workflow run outcomes over the last 30 days, from the support
 * reporting aggregates. The richer charted breakdown belongs in the Analytics
 * dashboard; this surfaces the headline numbers where the automation is managed.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { SettingsCard } from '@/components/admin/settings/settings-card'
import { supportReportingQuery } from '@/lib/client/queries/support-reporting'

const pct = (rate: number | null): string => (rate === null ? '—' : `${Math.round(rate * 100)}%`)

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-sm">{label}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}

export function SupportPerformanceCard() {
  const range = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - 30 * 86_400_000)
    return { from: from.toISOString(), to: to.toISOString() }
  }, [])
  const { data } = useQuery(supportReportingQuery(range.from, range.to))

  const fr = data?.sla.firstResponse
  const res = data?.sla.resolution
  const runs = (data?.workflows ?? []).reduce(
    (acc, w) => ({
      started: acc.started + w.started,
      completed: acc.completed + w.completed,
      interrupted: acc.interrupted + w.interrupted,
    }),
    { started: 0, completed: 0, interrupted: 0 }
  )

  return (
    <SettingsCard
      title="Performance"
      description="SLA attainment and workflow outcomes over the last 30 days."
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Metric
          label="First response SLA"
          value={pct(fr?.rate ?? null)}
          sub={fr ? `${fr.met} met / ${fr.breached} breached` : undefined}
        />
        <Metric
          label="Resolution SLA"
          value={pct(res?.rate ?? null)}
          sub={res ? `${res.met} met / ${res.breached} breached` : undefined}
        />
        <Metric
          label="Workflow runs"
          value={String(runs.started)}
          sub={`${runs.completed} completed, ${runs.interrupted} interrupted`}
        />
      </div>
    </SettingsCard>
  )
}
