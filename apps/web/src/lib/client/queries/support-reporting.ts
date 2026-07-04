import { queryOptions } from '@tanstack/react-query'
import { slaAttainmentFn, workflowEffectivenessFn } from '@/lib/server/functions/support-reporting'

/** SLA attainment + workflow effectiveness for a date range (ISO strings). */
export const supportReportingQuery = (from: string, to: string) =>
  queryOptions({
    queryKey: ['support-reporting', from, to],
    queryFn: async () => {
      const [sla, workflows] = await Promise.all([
        slaAttainmentFn({ data: { from, to } }),
        workflowEffectivenessFn({ data: { from, to } }),
      ])
      return { sla, workflows }
    },
    staleTime: 5 * 60 * 1000,
  })
