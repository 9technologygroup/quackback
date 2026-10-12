import { useEffect, useMemo, useState } from 'react'
import { useIntl } from 'react-intl'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { ArrowLeftIcon } from '@heroicons/react/24/outline'
import type { ApprovalView } from '@/lib/server/domains/assistant/approvals.queue'
import { approvalQueries, type ApprovalsView } from '@/lib/client/queries/approvals'
import { notificationsKeys } from '@/lib/client/hooks/use-notifications-queries'
import { markApprovalBellReadFn } from '@/lib/server/functions/approvals'
import { useMediaQuery } from '@/lib/client/hooks/use-media-query'
import { PageHeader } from '@/components/shared/page-header'
import { Spinner } from '@/components/shared/spinner'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getTimeAgo } from '@/components/ui/time-ago'
import { cn } from '@/lib/shared/utils'
import { approvalMessages, outcomeMessage } from './approval-messages'
import { requesterOf } from './approval-people'
import { ApprovalRiskChip } from './approval-risk-chip'
import { ApprovalDetail } from './approval-detail'

const route = getRouteApi('/admin/approvals')

/** Newest first; ids are time-ordered, so they settle a tie. */
function newestFirst(a: ApprovalView, b: ApprovalView): number {
  return b.proposedAt.localeCompare(a.proposedAt) || b.id.localeCompare(a.id)
}

export interface ApprovalsListProps {
  items: ApprovalView[]
  selectedId: string | null
  view: ApprovalsView
  onSelect: (id: string) => void
}

/** The requests in a tab: title, risk, who asked and when. */
export function ApprovalsList({ items, selectedId, view, onSelect }: ApprovalsListProps) {
  const intl = useIntl()
  if (items.length === 0)
    return (
      <p className="px-3.5 py-10 text-center text-sm text-muted-foreground">
        {intl.formatMessage(
          view === 'waiting' ? approvalMessages.emptyWaiting : approvalMessages.emptyDecided
        )}
      </p>
    )
  return (
    <ul className="space-y-0.5">
      {items.map((item) => {
        const outcome = outcomeMessage(item)
        const status = outcome ? intl.formatMessage(outcome) : null
        const on = item.id === selectedId
        return (
          <li key={item.id}>
            <button
              type="button"
              aria-current={on ? 'true' : undefined}
              onClick={() => onSelect(item.id)}
              className={cn(
                'block w-full rounded-lg px-3.5 py-3 text-start transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                on && 'bg-muted hover:bg-muted'
              )}
            >
              <span className="block text-sm font-medium leading-snug text-foreground">
                {item.summary}
              </span>
              <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <ApprovalRiskChip risk={item.risk} />
                <span>{requesterOf(item, intl)}</span>
                <span>· {getTimeAgo(item.proposedAt, intl.locale)}</span>
                {status && <span>· {status}</span>}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** The list and detail sit side by side from this width; below it, one shows at a time. */
const SIDE_BY_SIDE = '(min-width: 768px)'

/** The detail pane while the open request loads, or once it cannot be read. */
function DetailPlaceholder({
  state,
  onBack,
}: {
  state: 'loading' | 'missing'
  onBack: () => void
}) {
  const intl = useIntl()
  return (
    <div className="px-5 pt-6 pb-10 sm:px-9 sm:pt-7">
      <Button variant="ghost" size="sm" className="-ms-2 mb-3 md:hidden" onClick={onBack}>
        <ArrowLeftIcon className="size-4" aria-hidden="true" />
        {intl.formatMessage(approvalMessages.back)}
      </Button>
      {state === 'loading' ? (
        <div
          role="status"
          aria-label={intl.formatMessage(approvalMessages.loading)}
          className="flex justify-center py-12"
        >
          <Spinner size="lg" />
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {intl.formatMessage(approvalMessages.notFound)}
        </p>
      )}
    </div>
  )
}

/**
 * The Approvals page: what waits on the viewer and what was decided, with the
 * open request beside the list. The open request is always the one in the
 * URL, so a list that refreshes never swaps what the viewer is deciding;
 * beside the list the newest is opened once, and pinned there. A request
 * decided here stays in the Waiting list with its outcome, so the result
 * stays on screen.
 */
export function ApprovalsPage() {
  const intl = useIntl()
  const queryClient = useQueryClient()
  const navigate = route.useNavigate()
  const search = route.useSearch()
  const sideBySide = useMediaQuery(SIDE_BY_SIDE)
  const view: ApprovalsView = search.view === 'decided' ? 'decided' : 'waiting'
  const waitingQuery = useInfiniteQuery(approvalQueries.list('waiting'))
  const decidedQuery = useInfiniteQuery({
    ...approvalQueries.list('decided'),
    enabled: view === 'decided',
  })
  // The Waiting count is the rail's and Home's, from one read of everything waiting.
  const summary = useQuery(approvalQueries.waiting())
  // Requests as they stand after a decision or a refresh on this page, and
  // which of them were decided here.
  const [latest, setLatest] = useState<ReadonlyMap<string, ApprovalView>>(new Map())
  const [decidedHere, setDecidedHere] = useState<ReadonlySet<string>>(new Set())

  const waiting = useMemo(() => {
    const listed = (waitingQuery.data?.pages ?? [])
      .flatMap((page) => page.items)
      .map((item) => latest.get(item.id) ?? item)
    const listedIds = new Set(listed.map((item) => item.id))
    const kept = [...decidedHere]
      .filter((id) => !listedIds.has(id))
      .map((id) => latest.get(id))
      .filter((item): item is ApprovalView => !!item)
    return [...listed, ...kept].sort(newestFirst)
  }, [waitingQuery.data, latest, decidedHere])
  const decided = useMemo(
    () =>
      (decidedQuery.data?.pages ?? [])
        .flatMap((page) => page.items)
        .map((item) => latest.get(item.id) ?? item),
    [decidedQuery.data, latest]
  )
  const items = view === 'waiting' ? waiting : decided
  const waitingCount =
    summary.data?.count ?? waiting.filter((item) => item.status === 'proposed').length
  const listQuery = view === 'waiting' ? waitingQuery : decidedQuery
  // A failed read says so; it never reads as an empty list.
  const loading = listQuery.isPending && !listQuery.isError
  const listed = search.id ? items.find((item) => item.id === search.id) : undefined
  // A request opened by link that this tab does not list, such as one just decided elsewhere.
  const linked = useQuery({
    ...approvalQueries.detail(search.id ?? ''),
    enabled: !!search.id && !loading && !listed,
  })
  const selected = listed ?? (linked.data ? (latest.get(linked.data.id) ?? linked.data) : undefined)
  const placeholder = !search.id || selected ? null : linked.isError ? 'missing' : 'loading'

  // Opening Approvals reads the approval bell: what it counted is in front of
  // the viewer now. The bell refreshes when that cleared anything.
  useEffect(() => {
    void markApprovalBellReadFn()
      .then(({ marked }) =>
        marked > 0 ? queryClient.invalidateQueries({ queryKey: notificationsKeys.all }) : undefined
      )
      .catch(() => undefined)
  }, [queryClient])

  const select = (id: string | undefined) =>
    void navigate({ search: (prev) => ({ ...prev, id }), replace: true })

  // Beside the list, the newest request opens once and is pinned in the URL;
  // on a phone nothing opens until the viewer chooses.
  const newestId = items[0]?.id
  useEffect(() => {
    if (sideBySide && !search.id && !loading && newestId)
      void navigate({ search: (prev) => ({ ...prev, id: newestId }), replace: true })
  }, [sideBySide, search.id, loading, newestId, navigate])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-4 pt-4 sm:px-6">
        <PageHeader title={intl.formatMessage(approvalMessages.title)} />
        <Tabs
          variant="line"
          className="mt-3"
          value={view}
          onValueChange={(value) =>
            void navigate({
              search: (prev) => ({
                ...prev,
                view: value === 'decided' ? ('decided' as const) : undefined,
                id: undefined,
              }),
              replace: true,
            })
          }
        >
          <TabsList className="border-b-0">
            <TabsTrigger value="waiting">
              {intl.formatMessage(approvalMessages.waiting)}
              <span className="ms-1.5 text-xs tabular-nums text-muted-foreground">
                {waitingCount}
              </span>
            </TabsTrigger>
            <TabsTrigger value="decided">
              {intl.formatMessage(approvalMessages.decided)}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="flex min-h-0 flex-1 border-t border-border/50">
        <div
          data-slot="approvals-list"
          className={cn(
            'flex min-h-0 w-full shrink-0 flex-col border-border/50 md:w-80 md:border-r xl:w-[25rem]',
            search.id && 'hidden md:flex'
          )}
        >
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-2.5">
              {listQuery.isError ? (
                <div role="alert" className="space-y-3 px-3.5 py-10 text-center">
                  <p className="text-sm text-muted-foreground">
                    {intl.formatMessage(approvalMessages.loadFailed)}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={listQuery.isFetching}
                    onClick={() => void listQuery.refetch()}
                  >
                    {intl.formatMessage(approvalMessages.retry)}
                  </Button>
                </div>
              ) : loading ? (
                <div className="flex justify-center py-12">
                  <Spinner size="lg" />
                </div>
              ) : (
                <>
                  <ApprovalsList
                    items={items}
                    selectedId={search.id ?? null}
                    view={view}
                    onSelect={select}
                  />
                  {listQuery.hasNextPage && (
                    <div className="flex justify-center pt-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={listQuery.isFetchingNextPage}
                        onClick={() => void listQuery.fetchNextPage()}
                      >
                        {intl.formatMessage(approvalMessages.showMore)}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          </ScrollArea>
        </div>
        <div className={cn('min-w-0 flex-1', !search.id && 'hidden md:block')}>
          <ScrollArea className="h-full">
            {selected ? (
              <ApprovalDetail
                key={selected.id}
                approval={selected}
                decidedHere={decidedHere.has(selected.id)}
                onBack={() => select(undefined)}
                onChange={(approval, decided) => {
                  setLatest((previous) => new Map(previous).set(approval.id, approval))
                  if (decided) setDecidedHere((previous) => new Set(previous).add(approval.id))
                }}
              />
            ) : placeholder ? (
              <DetailPlaceholder state={placeholder} onBack={() => select(undefined)} />
            ) : null}
          </ScrollArea>
        </div>
      </div>
    </div>
  )
}
