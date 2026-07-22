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

  // Seed local editable state whenever a page loads.
  useEffect(() => {
    if (!issuesQ.data) return
    const next: Record<number, RowState> = {}
    for (const r of issuesQ.data.rows) {
      next[r.number] = {
        include: !r.alreadyImported && !!r.suggestedBoardId,
        boardId: r.suggestedBoardId ?? '',
        statusId: r.suggestedStatusId ?? '',
        tagIds: r.suggestedTagIds,
        roadmapId: NONE,
      }
    }
    setRowStates(next)
  }, [issuesQ.data])

  const setRow = (num: number, patch: Partial<RowState>) =>
    setRowStates((s) => ({ ...s, [num]: { ...s[num], ...patch } }))

  const statusQ = useQuery({
    queryKey: ['github-import', 'status', jobId],
    queryFn: () => getGitHubImportStatusFn({ data: { jobId: jobId as string } }),
    enabled: !!jobId,
    refetchInterval: (q) => {
      const st = q.state.data?.state
      return st === 'completed' || st === 'failed' ? false : 1500
    },
  })

  // When a job finishes, refresh the current page so imported flags update.
  useEffect(() => {
    const st = statusQ.data?.state
    if (st === 'completed' || st === 'failed') {
      queryClient.invalidateQueries({ queryKey: ['github-import', 'issues', page] })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusQ.data?.state])

  const importMutation = useMutation({
    mutationFn: (rows: ImportRowPayload[]) => startGitHubImportFn({ data: { rows } }),
    onSuccess: (res) => setJobId(res.jobId),
  })

  const startImport = () => {
    const rows: ImportRowPayload[] = (issuesQ.data?.rows ?? [])
      .filter((r) => rowStates[r.number]?.include && rowStates[r.number]?.boardId)
      .map((r) => {
        const st = rowStates[r.number]
        return {
          number: r.number,
          title: r.title,
          body: r.body,
          url: r.url,
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
  const tagOptions = (tagsQ.data ?? []).map((t) => ({ value: t.id as string, label: t.name }))

  const progress = statusQ.data?.progress
  const jobState = statusQ.data?.state
  const importing = !!jobId && jobState !== 'completed' && jobState !== 'failed'
  const includedCount = (issuesQ.data?.rows ?? []).filter(
    (r) => rowStates[r.number]?.include
  ).length

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

        {progress && (
          <div className="rounded-md border p-3 text-sm">
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
              {progress.imported} imported · {progress.skipped} skipped · {progress.errors} errors
            </div>
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
                  <TableHead className="w-8" />
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
