import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useIntl } from 'react-intl'
import { SettingsCard } from '@/components/admin/settings/settings-card'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { assistantQueries } from '@/lib/client/queries/assistant'
import { useUpdateAssistantIdentity } from '@/lib/client/mutations/assistant'
import type { AssistantIdentity } from '@/lib/shared/assistant/config'
import {
  AssistantSaveFeedback,
  type AssistantSaveState,
  isAssistantFieldManaged,
  isAssistantRevisionConflict,
  ManagedSettingHint,
  useUnsavedChanges,
} from './assistant-form'

function identityEquals(a: AssistantIdentity | null, b: AssistantIdentity | null): boolean {
  return Boolean(
    a && b && a.name === b.name && a.avatarUrl === b.avatarUrl && a.showAiLabel === b.showAiLabel
  )
}

export function AssistantIdentityCard() {
  const intl = useIntl()
  const settingsQuery = useQuery(assistantQueries.settings())
  const updateIdentity = useUpdateAssistantIdentity()
  const [draft, setDraft] = useState<AssistantIdentity | null>(null)
  const [saved, setSaved] = useState<AssistantIdentity | null>(null)
  const [saveState, setSaveState] = useState<AssistantSaveState>('idle')

  const dirty = Boolean(draft && saved && !identityEquals(draft, saved))
  useUnsavedChanges(dirty, 'basics')

  useEffect(() => {
    if (!settingsQuery.data || dirty) return
    setDraft(settingsQuery.data.config.identity)
    setSaved(settingsQuery.data.config.identity)
  }, [settingsQuery.data, dirty])

  if (settingsQuery.isError) {
    return (
      <SettingsCard
        title={intl.formatMessage({
          id: 'automation.agent.identity.title',
          defaultMessage: 'Identity',
        })}
      >
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-destructive">
            {intl.formatMessage({
              id: 'automation.agent.loadError',
              defaultMessage: 'AI agent settings could not be loaded.',
            })}
          </p>
          <Button variant="outline" size="sm" onClick={() => void settingsQuery.refetch()}>
            {intl.formatMessage({ id: 'automation.agent.retry', defaultMessage: 'Try again' })}
          </Button>
        </div>
      </SettingsCard>
    )
  }

  if (settingsQuery.isPending || !draft || !saved) {
    return (
      <SettingsCard
        title={intl.formatMessage({
          id: 'automation.agent.identity.title',
          defaultMessage: 'Identity',
        })}
      >
        <p role="status" className="text-sm text-muted-foreground">
          {intl.formatMessage({
            id: 'automation.agent.loading',
            defaultMessage: 'Loading AI agent settings…',
          })}
        </p>
      </SettingsCard>
    )
  }

  const managedPaths = settingsQuery.data.managedFieldPaths
  const nameManaged = isAssistantFieldManaged(managedPaths, 'identity.name')
  const avatarManaged = isAssistantFieldManaged(managedPaths, 'identity.avatarUrl')
  const labelManaged = isAssistantFieldManaged(managedPaths, 'identity.showAiLabel')
  const nameError = draft.name.trim()
    ? draft.name.length > 80
      ? intl.formatMessage({
          id: 'automation.agent.identity.nameTooLong',
          defaultMessage: 'Use 80 characters or fewer.',
        })
      : null
    : intl.formatMessage({
        id: 'automation.agent.identity.nameRequired',
        defaultMessage: 'Enter a name for your AI agent.',
      })
  let avatarError: string | null = null
  if (draft.avatarUrl && draft.avatarUrl.length > 2_000) {
    avatarError = intl.formatMessage({
      id: 'automation.agent.identity.avatarTooLong',
      defaultMessage: 'Use 2,000 characters or fewer.',
    })
  } else if (draft.avatarUrl) {
    try {
      const url = new URL(draft.avatarUrl)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol')
    } catch {
      avatarError = intl.formatMessage({
        id: 'automation.agent.identity.avatarInvalid',
        defaultMessage: 'Enter a valid HTTP or HTTPS URL.',
      })
    }
  }

  async function reloadLatest() {
    const result = await settingsQuery.refetch()
    if (!result.data) return
    setDraft(result.data.config.identity)
    setSaved(result.data.config.identity)
    setSaveState('idle')
  }

  async function save() {
    if (nameError || avatarError || !settingsQuery.data) return
    const identity = draft
    if (!identity) return
    setSaveState('saving')
    try {
      const result = await updateIdentity.mutateAsync({
        expectedRevision: settingsQuery.data.revision,
        identity: {
          name: identity.name.trim(),
          avatarUrl: identity.avatarUrl?.trim() || null,
          showAiLabel: identity.showAiLabel,
        },
      })
      setDraft(result.config.identity)
      setSaved(result.config.identity)
      setSaveState('saved')
    } catch (error) {
      setSaveState(isAssistantRevisionConflict(error) ? 'conflict' : 'error')
    }
  }

  return (
    <SettingsCard
      title={intl.formatMessage({
        id: 'automation.agent.identity.title',
        defaultMessage: 'Identity',
      })}
      description={intl.formatMessage({
        id: 'automation.agent.identity.description',
        defaultMessage: 'Choose how the AI agent appears to customers.',
      })}
    >
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <Avatar src={draft.avatarUrl} name={draft.name || 'AI'} className="size-10 text-sm" />
          <p className="max-w-xl text-xs text-muted-foreground">
            {intl.formatMessage({
              id: 'automation.agent.identity.previewHelp',
              defaultMessage: 'This identity appears in the Web widget and customer conversations.',
            })}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="assistant-name">
            {intl.formatMessage({ id: 'automation.agent.identity.name', defaultMessage: 'Name' })}
          </Label>
          <Input
            id="assistant-name"
            value={draft.name}
            aria-invalid={Boolean(nameError)}
            aria-describedby={nameError ? 'assistant-name-error' : undefined}
            disabled={nameManaged || saveState === 'saving'}
            onChange={(event) => {
              setDraft({ ...draft, name: event.target.value })
              setSaveState('idle')
            }}
          />
          {nameError && (
            <p id="assistant-name-error" className="text-xs text-destructive">
              {nameError}
            </p>
          )}
          {nameManaged && <ManagedSettingHint />}
        </div>

        <div className="space-y-2">
          <Label htmlFor="assistant-avatar">
            {intl.formatMessage({
              id: 'automation.agent.identity.avatar',
              defaultMessage: 'Avatar URL',
            })}
          </Label>
          <Input
            id="assistant-avatar"
            type="url"
            value={draft.avatarUrl ?? ''}
            placeholder={intl.formatMessage({
              id: 'automation.agent.identity.avatarPlaceholder',
              defaultMessage: 'https://example.com/agent.png',
            })}
            aria-invalid={Boolean(avatarError)}
            aria-describedby={avatarError ? 'assistant-avatar-error' : 'assistant-avatar-help'}
            disabled={avatarManaged || saveState === 'saving'}
            onChange={(event) => {
              setDraft({ ...draft, avatarUrl: event.target.value || null })
              setSaveState('idle')
            }}
          />
          {avatarError ? (
            <p id="assistant-avatar-error" className="text-xs text-destructive">
              {avatarError}
            </p>
          ) : (
            <p id="assistant-avatar-help" className="text-xs text-muted-foreground">
              {intl.formatMessage({
                id: 'automation.agent.identity.avatarHelp',
                defaultMessage: 'Leave this empty to use the agent’s initial.',
              })}
            </p>
          )}
          {avatarManaged && <ManagedSettingHint />}
        </div>

        <div className="flex min-h-11 items-center justify-between gap-4 rounded-lg border border-border/50 p-3 sm:p-4">
          <div>
            <Label htmlFor="assistant-show-ai-label" className="cursor-pointer text-sm font-medium">
              {intl.formatMessage({
                id: 'automation.agent.identity.aiLabel',
                defaultMessage: 'Show AI label',
              })}
            </Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {intl.formatMessage({
                id: 'automation.agent.identity.aiLabelHelp',
                defaultMessage: 'Helps customers understand that they are talking to an AI agent.',
              })}
            </p>
            {labelManaged && <ManagedSettingHint />}
          </div>
          <Switch
            id="assistant-show-ai-label"
            checked={draft.showAiLabel}
            disabled={labelManaged || saveState === 'saving'}
            onCheckedChange={(checked) => {
              setDraft({ ...draft, showAiLabel: checked })
              setSaveState('idle')
            }}
          />
        </div>

        <AssistantSaveFeedback state={saveState} onReload={reloadLatest} />
        <div className="flex justify-end">
          <Button
            type="button"
            className="min-h-11 sm:min-h-9"
            disabled={!dirty || Boolean(nameError || avatarError) || saveState === 'saving'}
            onClick={() => void save()}
          >
            {saveState === 'saving'
              ? intl.formatMessage({
                  id: 'automation.agent.save.savingButton',
                  defaultMessage: 'Saving…',
                })
              : intl.formatMessage({
                  id: 'automation.agent.save.button',
                  defaultMessage: 'Save changes',
                })}
          </Button>
        </div>
      </div>
    </SettingsCard>
  )
}
