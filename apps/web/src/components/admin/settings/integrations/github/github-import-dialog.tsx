'use client'

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowPathIcon } from '@heroicons/react/24/solid'
import { adminQueries } from '@/lib/client/queries/admin'
import {
  fetchGitHubIssuesPageFn,
  startGitHubImportFn,
  getGitHubImportStatusFn,
} from '@/lib/server/integrations/github/import-functions'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { MultiSelect } from '@/components/ui/multi-select'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

const NONE = '__none__'
const PER_PAGE = 50

interface RowState {
  include: boolean
  boardId: string
  statusId: string
  tagIds: string[]
  roadmapId: string
}

interface ImportRowPayload {
  number: number
  title: string
  body: string
  url: string
  comments?: number
  authorLogin: string | null
  authorId: number | null
  createdAt: string
  boardId: string
  statusId?: string
  tagIds: string[]
  roadmapId?: string
}

interface GitHubImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function GitHubImportDialog({ open, onOpenChange }: GitHubImportDialogProps) {
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [rowStates, setRowStates] = useState<Record<number, RowState>>({})
  const [jobId, setJobId] = useState<string | null>(null)

  const boardsQ = useQuery(adminQueries.boards())
  const statusesQ = useQuery(adminQueries.statuses())
  const tagsQ = useQuery(adminQueries.tags())
  const roadmapsQ = useQuery(adminQueries.roadmaps())

  const issuesQ = useQuery({
    queryKey: ['github-import', 'issues', page],
    queryFn: () => fetchGitHubIssuesPageFn({ data: { page, perPage: PER_PAGE } }),
    enabled: open,
    staleTime: 60_000,
  })

  // Seed local editable state from suggestions. Merge (keyed by issue number)
  // so an incidental refetch (window focus, post-import invalidate) never wipes
  // the admin's manual edits; only unseen rows are seeded, and a freshly
  // imported row is unchecked so it isn't re-sent.
  useEffect(() => {
    if (!issuesQ.data) return
    setRowStates((prev) => {
      const next = { ...prev }
      for (const r of issuesQ.data.rows) {
        const existing = next[r.number]
        if (!existing) {
          next[r.number] = {
            include: !r.alreadyImported && !!r.suggestedBoardId,
            boardId: r.suggestedBoardId ?? '',
            statusId: r.suggestedStatusId ?? '',
            tagIds: r.suggestedTagIds,
            roadmapId: NONE,
          }
        } else if (r.alreadyImported && existing.include) {
          next[r.number] = { ...existing, include: false }
        }
      }
      return next
    })
  }, [issuesQ.data])

  const setRow = (num: number, patch: Partial<RowState>) =>
    setRowStates((s) => ({ ...s, [num]: { ...s[num], ...patch } }))

  const statusQ = useQuery({
    queryKey: ['github-import', 'status', jobId],
    queryFn: () => getGitHubImportStatusFn({ data: { jobId: jobId as string } }),
    enabled: !!jobId,
    refetchInterval: (q) => {
      const data = q.state.data
      // null = job evicted/unknown → stop; completed/failed → stop.
      if (data === null) return false
      const st = data?.state
      return st === 'completed' || st === 'failed' ? false : 1500
    },
  })

  const jobData = statusQ.data // GitHubImportStatus | null | undefined
  const jobMissing = !!jobId && jobData === null
  const jobState = jobData?.state
  const jobFailed = jobState === 'failed'
  const jobDone = jobState === 'completed'
  const importing = !!jobId && !jobMissing && !jobFailed && !jobDone
  const progress = jobData?.progress ?? null

  // When a job reaches a terminal state, refresh the page so imported flags update.
  useEffect(() => {
    if (jobDone || jobFailed || jobMissing) {
      queryClient.invalidateQueries({ queryKey: ['github-import', 'issues', page] })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobDone, jobFailed, jobMissing])

  const importMutation = useMutation({
    mutationFn: (rows: ImportRowPayload[]) => startGitHubImportFn({ data: { rows } }),
    onSuccess: (res) => setJobId(res.jobId),
  })

  // A row is importable only if it's included AND has a board — the button
  // count and the payload use this same predicate so they can't disagree.
  const importableRows = (issuesQ.data?.rows ?? []).filter(
    (r) => rowStates[r.number]?.include && rowStates[r.number]?.boardId
  )

  const startImport = () => {
    const rows: ImportRowPayload[] = importableRows.map((r) => {
      const st = rowStates[r.number]
      return {
        number: r.number,
        title: r.title,
        body: r.body,
        url: r.url,
        comments: r.comments,
        authorLogin: r.authorLogin,
        authorId: r.authorId,
        createdAt: r.createdAt,
        boardId: st.boardId,
        statusId: st.statusId || undefined,
        tagIds: st.tagIds,
        roadmapId: st.roadmapId === NONE ? undefined : st.roadmapId,
      }
    })
    if (rows.length) importMutation.mutate(rows)
  }

  const boards = boardsQ.data ?? []
  const statuses = statusesQ.data ?? []
  const roadmaps = roadmapsQ.data ?? []
  // Merge in the release-version tags the server ensured for this page so they
  // show up (labeled + pre-selected) in the Tags cell.
  const tagOptions = [
    ...(tagsQ.data ?? []).map((t) => ({ value: t.id as string, label: t.name })),
    ...(issuesQ.data?.releaseTags ?? []).map((t) => ({ value: t.id, label: t.name })),
  ].filter((opt, i, arr) => arr.findIndex((o) => o.value === opt.value) === i)
  const includedCount = importableRows.length

  // Master select-all over the selectable (not already-imported) rows on this page.
  const selectableRows = (issuesQ.data?.rows ?? []).filter((r) => !r.alreadyImported)
  const allSelected =
    selectableRows.length > 0 && selectableRows.every((r) => rowStates[r.number]?.include)
  const someSelected = selectableRows.some((r) => rowStates[r.number]?.include)
  const headerChecked: boolean | 'indeterminate' = allSelected
    ? true
    : someSelected
      ? 'indeterminate'
      : false

  const toggleAll = (checked: boolean) =>
    setRowStates((prev) => {
      const next = { ...prev }
      for (const r of selectableRows) {
        if (next[r.number]) next[r.number] = { ...next[r.number], include: checked }
      }
      return next
    })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Import GitHub issues</DialogTitle>
          <DialogDescription>
            Review and adjust each issue&rsquo;s mapping, then import this page. Already-imported
            issues are skipped.
          </DialogDescription>
        </DialogHeader>

        {issuesQ.data?.releaseScopeMissing && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
            Reconnect GitHub with project access to import each issue&rsquo;s{' '}
            <span className="font-medium">Release version</span> as a tag.
          </div>
        )}

        {jobId && (progress || jobFailed || jobMissing) && (
          <div className="rounded-md border p-3 text-sm">
            {jobMissing ? (
              <span className="text-destructive">
                Import status is no longer available (the job was evicted). Some rows may have been
                imported — the list below reflects the current state; anything not imported can be
                run again.
              </span>
            ) : jobFailed ? (
              <span className="text-destructive">
                Import failed
                {progress ? ` after ${progress.imported} imported` : ' before it started'}. Check
                the repository and connection, then try again.
              </span>
            ) : progress ? (
              <>
                <div className="mb-1 flex justify-between">
                  <span>{importing ? 'Importing…' : 'Import complete'}</span>
                  <span>
                    {progress.done}/{progress.total}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded bg-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{
                      width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
                    }}
                  />
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {progress.imported} imported · {progress.skipped} skipped · {progress.errors}{' '}
                  errors
                </div>
              </>
            ) : null}
          </div>
        )}

        <div className="max-h-[60vh] overflow-auto">
          {issuesQ.isLoading ? (
            <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
              <ArrowPathIcon className="h-4 w-4 animate-spin" /> Loading issues…
            </div>
          ) : issuesQ.isError ? (
            <div className="p-6 text-sm text-destructive">
              Failed to load issues. Check the repository is configured and the connection is
              active.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      checked={headerChecked}
                      disabled={importing || selectableRows.length === 0}
                      onCheckedChange={(c) => toggleAll(c === true)}
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead>Issue</TableHead>
                  <TableHead>Board</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Roadmap</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(issuesQ.data?.rows ?? []).map((r) => {
                  const st = rowStates[r.number]
                  const disabled = r.alreadyImported || importing
                  return (
                    <TableRow key={r.number}>
                      <TableCell>
                        <Checkbox
                          checked={!!st?.include}
                          disabled={disabled}
                          onCheckedChange={(c) => setRow(r.number, { include: !!c })}
                        />
                      </TableCell>
                      <TableCell className="max-w-xs">
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium hover:underline"
                        >
                          #{r.number} {r.title}
                        </a>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {r.alreadyImported && <Badge variant="secondary">Imported</Badge>}
                          {r.milestone && <Badge variant="outline">{r.milestone}</Badge>}
                          {r.labels.slice(0, 3).map((l) => (
                            <Badge key={l} variant="outline">
                              {l}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={st?.boardId ?? ''}
                          onValueChange={(v) => setRow(r.number, { boardId: v })}
                          disabled={disabled}
                        >
                          <SelectTrigger className="h-8 w-36">
                            <SelectValue placeholder="Board" />
                          </SelectTrigger>
                          <SelectContent>
                            {boards.map((b) => (
                              <SelectItem key={b.id} value={b.id as string}>
                                {b.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={st?.statusId ?? ''}
                          onValueChange={(v) => setRow(r.number, { statusId: v })}
                          disabled={disabled}
                        >
                          <SelectTrigger className="h-8 w-32">
                            <SelectValue placeholder="Status" />
                          </SelectTrigger>
                          <SelectContent>
                            {statuses.map((s) => (
                              <SelectItem key={s.id} value={s.id as string}>
                                {s.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <MultiSelect
                          value={st?.tagIds ?? []}
                          onChange={(ids) => setRow(r.number, { tagIds: ids })}
                          options={tagOptions}
                          placeholder="Tags"
                          disabled={disabled}
                          className="w-36"
                        />
                      </TableCell>
                      <TableCell>
                        <Select
                          value={st?.roadmapId ?? NONE}
                          onValueChange={(v) => setRow(r.number, { roadmapId: v })}
                          disabled={disabled}
                        >
                          <SelectTrigger className="h-8 w-36">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>None</SelectItem>
                            {roadmaps.map((rm) => (
                              <SelectItem key={rm.id} value={rm.id as string}>
                                {rm.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1 || importing}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <span className="text-sm text-muted-foreground">Page {page}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={!issuesQ.data?.hasNextPage || importing}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
          <Button
            onClick={startImport}
            disabled={importing || includedCount === 0 || importMutation.isPending}
          >
            {importing ? 'Importing…' : `Import ${includedCount} selected`}
          </Button>
        </div>

        {importMutation.isError && (
          <div className="text-sm text-destructive">
            {importMutation.error instanceof Error
              ? importMutation.error.message
              : 'Failed to start import'}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
