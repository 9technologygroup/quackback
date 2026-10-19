import { createFileRoute } from '@tanstack/react-router'
import { isValidTypeId } from '@quackback/ids'
import { ApprovalsPage } from '@/components/admin/approvals/approvals-page'
import { adminPageHead } from '@/lib/client/admin-head'

interface ApprovalsSearch {
  view?: 'decided'
  /** The request open beside the list. */
  id?: string
}

export const Route = createFileRoute('/admin/approvals')({
  head: adminPageHead('Approvals'),
  validateSearch: (search: Record<string, unknown>): ApprovalsSearch => ({
    view: search.view === 'decided' ? 'decided' : undefined,
    id:
      typeof search.id === 'string' && isValidTypeId(search.id, 'assistant_action')
        ? search.id
        : undefined,
  }),
  // Every teammate may open the page: each sees only the requests they may
  // decide. The list arrives with the page; a failed read is left to the
  // page's own query.
  loader: async ({ context }) => {
    // Loaded here, not imported above, so the rest of Approvals stays out of
    // the code every admin page loads.
    const { approvalQueries } = await import('@/lib/client/queries/approvals')
    await context.queryClient
      .ensureInfiniteQueryData(approvalQueries.list('waiting'))
      .catch(() => undefined)
  },
  component: ApprovalsPage,
})
