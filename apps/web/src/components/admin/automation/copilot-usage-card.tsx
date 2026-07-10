/**
 * Copilot usage + outcome reporting (P2-D.2): questions asked, transforms
 * run, on-demand summaries, and the propose-approve-execute actions funnel,
 * over the last 30 days. Read-only reporting; gated server-side on
 * analytics.view like the rest of the Quinn performance surface. Mounted
 * only when assistantTools is on — the pending-actions funnel this card
 * reports on doesn't exist otherwise (see automation.assistant.tsx).
 */
import { useQuery } from '@tanstack/react-query'
import { SettingsCard } from '@/components/admin/settings/settings-card'
import { MetricTile, useLast30DaysRange, pct, asRate } from './metric-tile'
import { copilotUsageMetricsQuery } from '@/lib/client/queries/assistant-copilot-analytics'

/** Admin-facing labels for the raw metadata.transform values. Falls back to
 *  the raw value itself for anything not in the catalogue, so a legacy or
 *  future transform kind still renders instead of disappearing. */
const TRANSFORM_LABELS: Record<string, string> = {
  my_tone: 'My tone',
  more_friendly: 'More friendly',
  more_formal: 'More formal',
  more_concise: 'More concise',
  expand: 'Expand',
  rephrase: 'Rephrase',
  fix_grammar: 'Fix grammar',
}

export function CopilotUsageCard() {
  const range = useLast30DaysRange()
  const { data } = useQuery(copilotUsageMetricsQuery(range.from, range.to))

  const transforms = data?.transformsByKind ?? []
  const teammates = data?.perTeammate ?? []

  return (
    <SettingsCard
      title="Copilot usage"
      description="Questions, transforms, summaries, and proposed actions from the inbox Copilot sidebar, over the last 30 days."
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricTile label="Questions asked" value={data ? String(data.totalQuestions) : '—'} />
        <MetricTile label="Transforms run" value={data ? String(data.totalTransforms) : '—'} />
        <MetricTile label="Summaries generated" value={data ? String(data.totalSummaries) : '—'} />
        <MetricTile
          label="Approval rate"
          value={pct(asRate(data?.approvalRate))}
          sub={data ? `${data.actionsApproved} of ${data.actionsProposed} proposed` : undefined}
        />
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-medium">Top teammates</h3>
          {teammates.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              No Copilot questions for this period.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {teammates.map((teammate) => (
                <li
                  key={teammate.principalId}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span className="truncate">{teammate.displayName ?? 'Unknown teammate'}</span>
                  <span className="tabular-nums text-muted-foreground">{teammate.questions}</span>
                </li>
              ))}
            </ul>
          )}

          {transforms.length > 0 && (
            <>
              <h3 className="mt-4 mb-2 text-sm font-medium">Transforms by kind</h3>
              <ul className="space-y-1.5">
                {transforms.map((row) => (
                  <li
                    key={row.transform}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="truncate">
                      {TRANSFORM_LABELS[row.transform] ?? row.transform}
                    </span>
                    <span className="tabular-nums text-muted-foreground">{row.count}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium">Actions funnel</h3>
          <ul className="space-y-1.5 text-sm">
            <li className="flex items-center justify-between gap-2">
              <span>Proposed</span>
              <span className="tabular-nums text-muted-foreground">
                {data ? data.actionsProposed : '—'}
              </span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span>Approved</span>
              <span className="tabular-nums text-muted-foreground">
                {data ? data.actionsApproved : '—'}
              </span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span>Rejected</span>
              <span className="tabular-nums text-muted-foreground">
                {data ? data.actionsRejected : '—'}
              </span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span>Expired</span>
              <span className="tabular-nums text-muted-foreground">
                {data ? data.actionsExpired : '—'}
              </span>
            </li>
          </ul>
        </div>
      </div>
    </SettingsCard>
  )
}
