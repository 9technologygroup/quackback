import { queryOptions } from '@tanstack/react-query'
import { listWorkflowsFn, getWorkflowFn } from '@/lib/server/functions/workflows'

/** Query keys for the workflows manager (AI & Automation). */
export const workflowKeys = {
  all: () => ['workflows'] as const,
  detail: (id: string) => ['workflows', id] as const,
}

/** Every workflow, in drag order (the AI & Automation manager list). */
export const workflowsQuery = () =>
  queryOptions({
    queryKey: workflowKeys.all(),
    queryFn: () => listWorkflowsFn(),
    staleTime: 60 * 1000,
  })

/** One workflow (null if deleted/missing), for the fullscreen builder route. */
export const workflowDetailQuery = (id: string) =>
  queryOptions({
    queryKey: workflowKeys.detail(id),
    queryFn: () => getWorkflowFn({ data: { id } }),
    staleTime: 30 * 1000,
  })
