import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUpTrayIcon,
  DocumentTextIcon,
  XMarkIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ArrowDownTrayIcon,
} from '@heroicons/react/24/solid'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { adminQueries } from '@/lib/client/queries/admin'
import { CSV_TEMPLATE } from '@/lib/shared/schemas/import'
import type { ImportRunListItem } from './import-history-list'

type UploadState = 'idle' | 'uploading' | 'polling' | 'done' | 'failed'

const IN_FLIGHT = new Set(['pending', 'dry_run', 'running'])

/**
 * Board-CSV entry point into the hub (§I1). Uploads once, then polls the
 * created run until it lands on completed/failed. The full mapping wizard
 * (field/status/board mapping + dry run) replaces this in §I2; this is
 * intentionally the same single-step upload the board-level tab used to
 * host, just pointed at the async contract.
 */
export function QuickImportUploader() {
  const queryClient = useQueryClient()
  const [state, setState] = useState<UploadState>('idle')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [boardId, setBoardId] = useState<string>('')
  const [runId, setRunId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const boardsQuery = useQuery(adminQueries.boardsForSettings())

  const runQuery = useQuery({
    queryKey: ['import-run', runId],
    queryFn: async () => {
      const res = await fetch(`/api/import/runs/${runId}`)
      if (!res.ok) throw new Error('Failed to load import status')
      const body = (await res.json()) as { run: ImportRunListItem }
      return body.run
    },
    enabled: !!runId,
    refetchInterval: (query) => (query.state.data && IN_FLIGHT.has(query.state.data.status) ? 1500 : false),
  })

  const run = runQuery.data
  if (run && state === 'polling' && !IN_FLIGHT.has(run.status)) {
    // Landed on a terminal state — stop treating this as "polling" and
    // refresh the history list below so the completed run shows up there too.
    setState(run.status === 'failed' ? 'failed' : 'done')
    void queryClient.invalidateQueries({ queryKey: ['import-runs'] })
  }

  const handleFileSelect = (file: File) => {
    setError(null)
    if (!file.type.includes('csv') && !file.name.endsWith('.csv')) {
      setError('Please select a CSV file')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('File size must be less than 10MB')
      return
    }
    setSelectedFile(file)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFileSelect(file)
  }

  const handleImport = async () => {
    if (!selectedFile) return
    setError(null)
    setState('uploading')

    try {
      const formData = new FormData()
      formData.append('file', selectedFile)
      if (boardId) formData.append('boardId', boardId)

      const response = await fetch('/api/import', { method: 'POST', body: formData })
      const data = (await response.json()) as { runId?: string; error?: string }

      if (!response.ok || !data.runId) {
        throw new Error(data.error || 'Import failed to start')
      }

      setRunId(data.runId)
      setState('polling')
    } catch (err) {
      setState('failed')
      setError(err instanceof Error ? err.message : 'Import failed to start')
    }
  }

  const handleReset = () => {
    setState('idle')
    setSelectedFile(null)
    setRunId(null)
    setError(null)
  }

  const downloadTemplate = () => {
    const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'import-template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (state === 'idle' || state === 'uploading') {
    return (
      <div className="space-y-4">
        <div
          className="border-2 border-dashed border-border/50 rounded-lg p-8 text-center hover:border-primary/50 transition-colors cursor-pointer"
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
          />
          {selectedFile ? (
            <div className="flex items-center justify-center gap-2">
              <DocumentTextIcon className="h-5 w-5 text-primary" />
              <span className="text-sm font-medium">{selectedFile.name}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Remove file"
                onClick={(e) => {
                  e.stopPropagation()
                  setSelectedFile(null)
                }}
              >
                <XMarkIcon className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>
          ) : (
            <>
              <ArrowUpTrayIcon className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">Drop a CSV file here or click to browse</p>
              <p className="text-xs text-muted-foreground mt-1">Maximum 10MB, up to 10,000 rows</p>
            </>
          )}
        </div>

        {boardsQuery.data && boardsQuery.data.length > 0 && (
          <div
            className="flex items-center gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-sm text-muted-foreground shrink-0">Board</span>
            <Select value={boardId} onValueChange={setBoardId}>
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue placeholder="First board (default)" />
              </SelectTrigger>
              <SelectContent>
                {boardsQuery.data.map((board) => (
                  <SelectItem key={board.id} value={board.id}>
                    {board.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {error && (
          <div className="p-3 bg-destructive/10 text-destructive text-sm rounded-lg flex items-center gap-2">
            <ExclamationCircleIcon className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <Button
            onClick={handleImport}
            disabled={!selectedFile || state === 'uploading'}
            className="w-full sm:w-auto"
          >
            {state === 'uploading' ? (
              <ArrowPathIcon className="size-4 animate-spin" />
            ) : (
              <ArrowUpTrayIcon className="size-4" />
            )}
            Import Data
          </Button>
          <Button variant="outline" onClick={downloadTemplate} className="w-full sm:w-auto">
            <ArrowDownTrayIcon className="size-4" />
            Download Template
          </Button>
        </div>
      </div>
    )
  }

  if (state === 'polling') {
    return (
      <div className="flex items-center gap-3">
        <ArrowPathIcon className="h-5 w-5 animate-spin text-primary" />
        <span className="text-sm font-medium">
          {run?.status === 'running' ? 'Importing...' : 'Queued...'}
        </span>
      </div>
    )
  }

  if (state === 'done' && run) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 text-primary">
          <CheckCircleIcon className="h-5 w-5" />
          <span className="font-medium">Import complete</span>
        </div>
        <div className="bg-muted/50 rounded-lg p-4 space-y-1 text-sm">
          <p>
            <span className="font-medium">{run.totals?.created ?? 0}</span> posts imported
          </p>
          {(run.totals?.skipped ?? 0) > 0 && (
            <p className="text-muted-foreground">
              <span className="font-medium">{run.totals?.skipped}</span> rows skipped
            </p>
          )}
        </div>
        <Button onClick={handleReset}>Import more</Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-destructive">
        <ExclamationCircleIcon className="h-5 w-5" />
        <span className="font-medium">Import failed</span>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button onClick={handleReset} variant="outline">
        Try again
      </Button>
    </div>
  )
}
