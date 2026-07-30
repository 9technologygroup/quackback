'use client'

import { useState, useEffect, useCallback } from 'react'
import { ArrowPathIcon, FolderIcon } from '@heroicons/react/24/solid'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { useUpdateIntegration } from '@/lib/client/mutations'
import { fetchGitHubReposFn, type GitHubRepo } from '@/lib/server/integrations/github/functions'
import { fetchBoardsFn } from '@/lib/server/functions/boards'
import { StatusSyncConfig } from '@/components/admin/settings/integrations/status-sync-config'
import { OnDeleteConfig } from '@/components/admin/settings/integrations/on-delete-config'
import { BoardFilterCombobox } from '@/components/admin/settings/integrations/shared/board-filter-combobox'
import { GitHubImportDialog } from './github-import-dialog'

interface EventMapping {
  id: string
  eventType: string
  enabled: boolean
  boardIds?: string[] | null
}

interface GitHubConfigProps {
  integrationId: string
  initialConfig: Record<string, unknown>
  initialEventMappings: EventMapping[]
  enabled: boolean
}

/**
 * `direction: 'outbound'` events fire from Quackback domain events and honour
 * the board scope below. Inbound events originate at GitHub and are governed by
 * the inbound board setting instead, so they never carry a board filter.
 */
const EVENT_CONFIG = [
  {
    id: 'post.created' as const,
    direction: 'outbound' as const,
    label: 'Create issue from new feedback',
    description: 'Automatically create a GitHub issue when new feedback is submitted',
  },
  {
    id: 'post.status_changed' as const,
    direction: 'outbound' as const,
    label: 'Sync status changes',
    description: 'Update linked issues when feedback status changes',
  },
  {
    id: 'comment.created' as const,
    direction: 'outbound' as const,
    label: 'Send comments to GitHub',
    description: 'Post Quackback comments onto the linked issue. Private comments are never sent',
  },
  {
    id: 'issues.opened' as const,
    direction: 'inbound' as const,
    label: 'Create post from new GitHub issue',
    description:
      'When someone opens an issue on GitHub, create a matching post in the inbound board below',
  },
  {
    id: 'issue_comment.created' as const,
    direction: 'inbound' as const,
    label: 'Show GitHub comments in Quackback',
    description: 'Mirror comments made on a linked GitHub issue back onto the feedback post',
  },
]

const OUTBOUND_EVENT_IDS = EVENT_CONFIG.filter((e) => e.direction === 'outbound').map((e) => e.id)

export function GitHubConfig({
  integrationId,
  initialConfig,
  initialEventMappings,
  enabled,
}: GitHubConfigProps) {
  const updateMutation = useUpdateIntegration()
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [repoError, setRepoError] = useState<string | null>(null)
  const [selectedRepo, setSelectedRepo] = useState((initialConfig.channelId as string) || '')
  const [boards, setBoards] = useState<Array<{ id: string; name: string }>>([])
  const [selectedInboundBoard, setSelectedInboundBoard] = useState(
    (initialConfig.inboundBoardId as string) || ''
  )
  const [integrationEnabled, setIntegrationEnabled] = useState(enabled)
  const [importOpen, setImportOpen] = useState(false)
  const [eventSettings, setEventSettings] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      EVENT_CONFIG.map((event) => [
        event.id,
        initialEventMappings.find((m) => m.eventType === event.id)?.enabled ?? false,
      ])
    )
  )
  // One board scope shared by every outbound event — "these boards talk to
  // GitHub". Hydrated from whichever outbound mapping already carries a filter.
  const [outboundBoardIds, setOutboundBoardIds] = useState<string[] | null>(
    () =>
      initialEventMappings.find(
        (m) => OUTBOUND_EVENT_IDS.some((id) => id === m.eventType) && m.boardIds?.length
      )?.boardIds ?? null
  )

  const fetchRepos = useCallback(async () => {
    setLoadingRepos(true)
    setRepoError(null)
    try {
      const result = await fetchGitHubReposFn()
      setRepos(result)
    } catch {
      setRepoError('Failed to load repositories. Please try again.')
    } finally {
      setLoadingRepos(false)
    }
  }, [])

  useEffect(() => {
    fetchRepos()
  }, [fetchRepos])

  useEffect(() => {
    fetchBoardsFn()
      .then((result) => setBoards(result.map((b) => ({ id: b.id, name: b.name }))))
      .catch(() => setBoards([]))
  }, [])

  const handleEnabledChange = (checked: boolean) => {
    setIntegrationEnabled(checked)
    updateMutation.mutate({ id: integrationId, enabled: checked })
  }

  const handleRepoChange = (repoFullName: string) => {
    setSelectedRepo(repoFullName)
    updateMutation.mutate({ id: integrationId, config: { channelId: repoFullName } })
  }

  const handleInboundBoardChange = (boardId: string) => {
    setSelectedInboundBoard(boardId)
    updateMutation.mutate({ id: integrationId, config: { inboundBoardId: boardId } })
  }

  /**
   * Persist every mapping on each change. Outbound mappings carry the shared
   * board scope; inbound ones are always sent unfiltered so a stale filter can
   * never survive on them.
   */
  const persistEventMappings = (settings: Record<string, boolean>, boardIds: string[] | null) => {
    updateMutation.mutate({
      id: integrationId,
      eventMappings: Object.entries(settings).map(([eventType, enabled]) => ({
        eventType,
        enabled,
        boardIds: OUTBOUND_EVENT_IDS.some((id) => id === eventType) ? boardIds : null,
      })),
    })
  }

  const handleEventToggle = (eventId: string, checked: boolean) => {
    const newSettings = { ...eventSettings, [eventId]: checked }
    setEventSettings(newSettings)
    persistEventMappings(newSettings, outboundBoardIds)
  }

  const handleOutboundBoardsChange = (boardIds: string[] | null) => {
    setOutboundBoardIds(boardIds)
    persistEventMappings(eventSettings, boardIds)
  }

  const saving = updateMutation.isPending

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="enabled-toggle" className="text-base font-medium">
            Integration enabled
          </Label>
          <p className="text-xs text-muted-foreground">
            Turn off to pause all GitHub issue syncing
          </p>
        </div>
        <Switch
          id="enabled-toggle"
          checked={integrationEnabled}
          onCheckedChange={handleEnabledChange}
          disabled={saving}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="repo-select">Repository</Label>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setImportOpen(true)}
              disabled={!selectedRepo || !integrationEnabled}
              className="h-8 text-xs"
            >
              Import issues
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchRepos}
              disabled={loadingRepos}
              className="h-8 gap-1.5 text-xs"
            >
              <ArrowPathIcon className={`h-3.5 w-3.5 ${loadingRepos ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>
        {repoError ? (
          <p className="text-sm text-destructive">{repoError}</p>
        ) : (
          <Select
            value={selectedRepo}
            onValueChange={handleRepoChange}
            disabled={loadingRepos || saving || !integrationEnabled}
          >
            <SelectTrigger id="repo-select" className="w-full">
              {loadingRepos ? (
                <div className="flex items-center gap-2">
                  <ArrowPathIcon className="h-4 w-4 animate-spin" />
                  <span>Loading repositories...</span>
                </div>
              ) : (
                <SelectValue placeholder="Select a repository" />
              )}
            </SelectTrigger>
            <SelectContent>
              {repos.map((repo) => (
                <SelectItem key={repo.id} value={repo.fullName}>
                  <div className="flex items-center gap-2">
                    <FolderIcon className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>{repo.fullName}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <p className="text-xs text-muted-foreground">
          New feedback issues will be created in this repository.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="inbound-board-select">Inbound issues board</Label>
        <Select
          value={selectedInboundBoard}
          onValueChange={handleInboundBoardChange}
          disabled={saving || !integrationEnabled}
        >
          <SelectTrigger id="inbound-board-select" className="w-full">
            <SelectValue placeholder="Select a board" />
          </SelectTrigger>
          <SelectContent>
            {boards.map((board) => (
              <SelectItem key={board.id} value={board.id}>
                {board.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          When &ldquo;Create post from new GitHub issue&rdquo; is on, new issues become posts in
          this board.
        </p>
      </div>

      <div className="space-y-3">
        <Label className="text-base font-medium">Events</Label>
        <p className="text-xs text-muted-foreground">
          Choose which events sync between Quackback and GitHub
        </p>
        <div className="space-y-3 pt-2">
          {EVENT_CONFIG.map((event) => (
            <div
              key={event.id}
              className="flex items-center justify-between rounded-lg border border-border/50 p-3"
            >
              <div>
                <div className="font-medium text-sm">{event.label}</div>
                <div className="text-xs text-muted-foreground">{event.description}</div>
              </div>
              <Switch
                checked={eventSettings[event.id] ?? false}
                onCheckedChange={(checked) => handleEventToggle(event.id, checked)}
                disabled={saving || !integrationEnabled}
              />
            </div>
          ))}
        </div>

        {eventSettings['issue_comment.created'] && (
          <p className="rounded-lg border border-border/50 bg-muted/40 p-3 text-xs text-muted-foreground">
            Comment mirroring needs the repository webhook to listen for comment events. Connections
            made before this feature shipped only listen for issues &mdash; turn status sync off and
            on again below to refresh the webhook.
          </p>
        )}

        <div className="space-y-2 pt-2">
          <Label htmlFor="outbound-boards">Boards that sync to GitHub</Label>
          <BoardFilterCombobox
            boardIds={outboundBoardIds}
            boards={boards}
            onBoardIdsChange={handleOutboundBoardsChange}
            disabled={saving || !integrationEnabled}
            ariaLabel="Boards that sync to GitHub"
          />
          <p className="text-xs text-muted-foreground">
            Limits the outbound events above. Leave as{' '}
            <span className="font-medium text-foreground">All boards</span> and every new post opens
            a GitHub issue &mdash; pick your bug board to keep feature requests out of the repo.
            Does not affect issues or comments coming in from GitHub.
          </p>
        </div>
      </div>

      {saving && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ArrowPathIcon className="h-4 w-4 animate-spin" />
          <span>Saving...</span>
        </div>
      )}

      {updateMutation.isError && (
        <div className="text-sm text-destructive">
          {updateMutation.error?.message || 'Failed to save changes'}
        </div>
      )}

      <StatusSyncConfig
        integrationId={integrationId}
        integrationType="github"
        config={initialConfig}
        enabled={integrationEnabled}
        externalStatuses={[
          { id: 'Open', name: 'Open' },
          { id: 'Closed', name: 'Closed' },
        ]}
      />

      <OnDeleteConfig
        integrationId={integrationId}
        integrationType="github"
        config={initialConfig}
        enabled={integrationEnabled}
      />

      <GitHubImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  )
}
