import { queryOptions } from '@tanstack/react-query'
import { workflowEffectivenessFn } from '@/lib/server/functions/workflow-reporting'

/** Per-workflow run counts over the trailing 7 days, for the workflows list. */
export const workflowEffectivenessQuery = () =>
  queryOptions({
    queryKey: ['workflow-effectiveness', '7d'],
    queryFn: () => workflowEffectivenessFn(),
    staleTime: 5 * 60 * 1000,
  })
