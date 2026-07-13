import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useIntl } from 'react-intl'
import { SettingsCard } from '@/components/admin/settings/settings-card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { assistantQueries } from '@/lib/client/queries/assistant'
import { useUpdateAssistantChannels } from '@/lib/client/mutations/assistant'
import {
  AssistantSaveFeedback,
  type AssistantSaveState,
  isAssistantFieldManaged,
  isAssistantRevisionConflict,
  ManagedSettingHint,
  useUnsavedChanges,
} from './assistant-form'

const MAX_CHANNEL_INSTRUCTIONS = 1_000

export function ChannelInstructionsCard() {
  const intl = useIntl()
  const settingsQuery = useQuery(assistantQueries.settings())
  const updateChannels = useUpdateAssistantChannels()
  const [draft, setDraft] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<AssistantSaveState>('idle')
  const dirty = draft !== null && saved !== null && draft !== saved
  useUnsavedChanges(dirty, 'guidance')

  useEffect(() => {
    if (!settingsQuery.data || dirty) return
    const instructions = settingsQuery.data.config.channels.widget?.additionalInstructions ?? ''
    setDraft(instructions)
    setSaved(instructions)
  }, [settingsQuery.data, dirty])

  if (settingsQuery.isError) {
    return (
      <SettingsCard
        title={intl.formatMessage({
          id: 'automation.agent.channels.title',
          defaultMessage: 'Channel guidance',
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

  if (settingsQuery.isPending || draft === null || saved === null) {
    return (
      <SettingsCard
        title={intl.formatMessage({
          id: 'automation.agent.channels.title',
          defaultMessage: 'Channel guidance',
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

  const managed = isAssistantFieldManaged(
    settingsQuery.data.managedFieldPaths,
    'channels.widget.additionalInstructions'
  )
  const tooLong = draft.length > MAX_CHANNEL_INSTRUCTIONS

  async function reloadLatest() {
    const result = await settingsQuery.refetch()
    if (!result.data) return
    const instructions = result.data.config.channels.widget?.additionalInstructions ?? ''
    setDraft(instructions)
    setSaved(instructions)
    setSaveState('idle')
  }

  async function save() {
    if (!settingsQuery.data || tooLong) return
    const value = draft
    if (value === null) return
    const instructions = value.trim()
    const { widget: _widget, ...otherChannels } = settingsQuery.data.config.channels
    const channels = instructions
      ? { ...otherChannels, widget: { additionalInstructions: instructions } }
      : otherChannels
    setSaveState('saving')
    try {
      const result = await updateChannels.mutateAsync({
        expectedRevision: settingsQuery.data.revision,
        channels,
      })
      const savedInstructions = result.config.channels.widget?.additionalInstructions ?? ''
      setDraft(savedInstructions)
      setSaved(savedInstructions)
      setSaveState('saved')
    } catch (error) {
      setSaveState(isAssistantRevisionConflict(error) ? 'conflict' : 'error')
    }
  }

  return (
    <SettingsCard
      title={intl.formatMessage({
        id: 'automation.agent.channels.title',
        defaultMessage: 'Channel guidance',
      })}
      description={intl.formatMessage({
        id: 'automation.agent.channels.description',
        defaultMessage: 'Add instructions that only apply in a particular customer channel.',
      })}
    >
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="assistant-widget-instructions">
            {intl.formatMessage({
              id: 'automation.agent.channels.widget',
              defaultMessage: 'Web widget',
            })}
          </Label>
          <p className="text-xs text-muted-foreground">
            {intl.formatMessage({
              id: 'automation.agent.channels.widgetHelp',
              defaultMessage: 'Use these instructions only for replies in your Web widget.',
            })}
          </p>
        </div>
        <Textarea
          id="assistant-widget-instructions"
          value={draft}
          rows={5}
          disabled={managed || saveState === 'saving'}
          aria-invalid={tooLong}
          aria-describedby="assistant-widget-instructions-count"
          placeholder={intl.formatMessage({
            id: 'automation.agent.channels.placeholder',
            defaultMessage:
              'For example: Keep replies concise and link to the Help Center when useful.',
          })}
          onChange={(event) => {
            setDraft(event.target.value)
            setSaveState('idle')
          }}
        />
        <p
          id="assistant-widget-instructions-count"
          className={
            tooLong
              ? 'text-end text-xs tabular-nums text-destructive'
              : 'text-end text-xs tabular-nums text-muted-foreground'
          }
        >
          {intl.formatMessage(
            { id: 'automation.agent.channels.count', defaultMessage: '{used} of 1,000' },
            { used: draft.length }
          )}
        </p>
        {tooLong && (
          <p role="alert" className="text-xs text-destructive">
            {intl.formatMessage({
              id: 'automation.agent.channels.tooLong',
              defaultMessage: 'Use 1,000 characters or fewer.',
            })}
          </p>
        )}
        {managed && <ManagedSettingHint />}
        <AssistantSaveFeedback state={saveState} onReload={reloadLatest} />
        <div className="flex justify-end">
          <Button
            type="button"
            className="min-h-11 sm:min-h-9"
            disabled={!dirty || tooLong || saveState === 'saving'}
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
