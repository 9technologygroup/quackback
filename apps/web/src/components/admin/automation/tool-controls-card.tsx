import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useIntl } from 'react-intl'
import { SettingsCard } from '@/components/admin/settings/settings-card'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { assistantQueries } from '@/lib/client/queries/assistant'
import { useUpdateAssistantToolControls } from '@/lib/client/mutations/assistant'
import type { AssistantToolControl } from '@/lib/shared/assistant/config'
import type { AssistantToolSummary } from '@/lib/server/functions/assistant-guidance'
import {
  AssistantSaveFeedback,
  type AssistantSaveState,
  isAssistantFieldManaged,
  isAssistantRevisionConflict,
  ManagedSettingHint,
  useUnsavedChanges,
} from './assistant-form'

type ActionGroup = 'answer' | 'conversation' | 'records'

const GROUP_ORDER: ActionGroup[] = ['answer', 'conversation', 'records']

function actionGroup(tool: AssistantToolSummary): ActionGroup | null {
  if (tool.name === 'search_knowledge') return 'answer'
  if (tool.name === 'set_attribute' || tool.name === 'end_conversation') return 'conversation'
  if (tool.name === 'create_ticket' || tool.name === 'capture_feedback') return 'records'
  return null
}

function controlsEqual(
  left: Record<string, AssistantToolControl> | null,
  right: Record<string, AssistantToolControl> | null
): boolean {
  if (!left || !right) return left === right
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) if (left[key] !== right[key]) return false
  return true
}

export function ToolControlsCard({ available = true }: { available?: boolean }) {
  const intl = useIntl()
  const settingsQuery = useQuery(assistantQueries.settings())
  const toolsQuery = useQuery({ ...assistantQueries.tools(), enabled: available })
  const updateControls = useUpdateAssistantToolControls()
  const [draft, setDraft] = useState<Record<string, AssistantToolControl> | null>(null)
  const [saved, setSaved] = useState<Record<string, AssistantToolControl> | null>(null)
  const [saveState, setSaveState] = useState<AssistantSaveState>('idle')
  const dirty = !controlsEqual(draft, saved)
  useUnsavedChanges(dirty, 'actions')

  useEffect(() => {
    if (!settingsQuery.data || dirty) return
    setDraft(settingsQuery.data.config.toolControls)
    setSaved(settingsQuery.data.config.toolControls)
  }, [settingsQuery.data, dirty])

  if (!available) {
    return (
      <SettingsCard
        title={intl.formatMessage({
          id: 'automation.agent.actions.title',
          defaultMessage: 'Actions',
        })}
        description={intl.formatMessage({
          id: 'automation.agent.actions.description',
          defaultMessage: 'Choose what the AI agent may do while helping a customer.',
        })}
      >
        <p className="text-sm text-muted-foreground">
          {intl.formatMessage({
            id: 'automation.agent.actions.unavailable',
            defaultMessage:
              'Actions are not available for this workspace. Voice, guidance, and testing still work normally.',
          })}
        </p>
      </SettingsCard>
    )
  }

  if (settingsQuery.isError || toolsQuery.isError) {
    return (
      <SettingsCard
        title={intl.formatMessage({
          id: 'automation.agent.actions.title',
          defaultMessage: 'Actions',
        })}
      >
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-destructive">
            {intl.formatMessage({
              id: 'automation.agent.actions.loadError',
              defaultMessage: 'Actions could not be loaded.',
            })}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void settingsQuery.refetch()
              void toolsQuery.refetch()
            }}
          >
            {intl.formatMessage({ id: 'automation.agent.retry', defaultMessage: 'Try again' })}
          </Button>
        </div>
      </SettingsCard>
    )
  }

  if (settingsQuery.isPending || toolsQuery.isPending || !draft || !saved) {
    return (
      <SettingsCard
        title={intl.formatMessage({
          id: 'automation.agent.actions.title',
          defaultMessage: 'Actions',
        })}
      >
        <p role="status" className="text-sm text-muted-foreground">
          {intl.formatMessage({
            id: 'automation.agent.actions.loading',
            defaultMessage: 'Loading actions…',
          })}
        </p>
      </SettingsCard>
    )
  }

  const tools = toolsQuery.data.filter((tool) => actionGroup(tool) !== null)
  const grouped = GROUP_ORDER.map((group) => ({
    group,
    tools: tools.filter((tool) => actionGroup(tool) === group),
  })).filter(({ tools: groupTools }) => groupTools.length > 0)
  const allManaged = isAssistantFieldManaged(settingsQuery.data.managedFieldPaths, 'toolControls')

  const groupMessage = (group: ActionGroup) =>
    intl.formatMessage({
      id: `automation.agent.actions.group.${group}`,
      defaultMessage:
        group === 'answer'
          ? 'Answer and understand'
          : group === 'conversation'
            ? 'Update the conversation'
            : 'Create records',
    })

  const modeLabel = (mode: AssistantToolControl) =>
    intl.formatMessage({
      id: `automation.agent.actions.mode.${mode}.label`,
      defaultMessage:
        mode === 'disabled'
          ? 'Off'
          : mode === 'approval'
            ? 'Require teammate approval'
            : 'Runs automatically',
    })

  const modeDescription = (mode: AssistantToolControl) =>
    intl.formatMessage({
      id: `automation.agent.actions.mode.${mode}.description`,
      defaultMessage:
        mode === 'disabled'
          ? 'The AI agent cannot use this action.'
          : mode === 'approval'
            ? 'The AI agent can prepare the action, but a teammate must approve it.'
            : 'The AI agent may complete the action when its rules and permissions allow it.',
    })

  async function reloadLatest() {
    const result = await settingsQuery.refetch()
    if (!result.data) return
    setDraft(result.data.config.toolControls)
    setSaved(result.data.config.toolControls)
    setSaveState('idle')
  }

  async function save() {
    if (!settingsQuery.data) return
    const controls = draft
    if (!controls) return
    setSaveState('saving')
    try {
      const result = await updateControls.mutateAsync({
        expectedRevision: settingsQuery.data.revision,
        toolControls: controls,
      })
      setDraft(result.config.toolControls)
      setSaved(result.config.toolControls)
      setSaveState('saved')
    } catch (error) {
      setSaveState(isAssistantRevisionConflict(error) ? 'conflict' : 'error')
    }
  }

  return (
    <SettingsCard
      title={intl.formatMessage({
        id: 'automation.agent.actions.title',
        defaultMessage: 'Actions',
      })}
      description={intl.formatMessage({
        id: 'automation.agent.actions.description',
        defaultMessage: 'Choose what the AI agent may do while helping a customer.',
      })}
    >
      {tools.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {intl.formatMessage({
            id: 'automation.agent.actions.empty',
            defaultMessage:
              'Actions will appear here when the required product features are available.',
          })}
        </p>
      ) : (
        <div className="space-y-6">
          {grouped.map(({ group, tools: groupTools }) => (
            <section
              key={group}
              aria-labelledby={`assistant-actions-${group}`}
              className="space-y-2"
            >
              <h3 id={`assistant-actions-${group}`} className="text-sm font-medium">
                {groupMessage(group)}
              </h3>
              <div className="space-y-2">
                {groupTools.map((tool) => {
                  const mode = draft[tool.name] ?? tool.defaultMode
                  const managed =
                    allManaged ||
                    isAssistantFieldManaged(
                      settingsQuery.data.managedFieldPaths,
                      `toolControls.${tool.name}`
                    )
                  return (
                    <div
                      key={tool.name}
                      className="flex flex-col gap-3 rounded-lg border border-border/50 p-3 sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="min-w-0 max-w-xl">
                        <p className="text-sm font-medium">{tool.label}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{tool.description}</p>
                      </div>
                      <div className="w-full shrink-0 space-y-1.5 sm:w-64">
                        <Select
                          value={mode}
                          disabled={managed || saveState === 'saving'}
                          onValueChange={(value) => {
                            setDraft({ ...draft, [tool.name]: value as AssistantToolControl })
                            setSaveState('idle')
                          }}
                        >
                          <SelectTrigger
                            size="sm"
                            className="min-h-11 w-full sm:min-h-8"
                            aria-label={intl.formatMessage(
                              {
                                id: 'automation.agent.actions.modeAria',
                                defaultMessage: '{action} setting',
                              },
                              { action: tool.label }
                            )}
                          >
                            <SelectValue>{modeLabel(mode)}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {tool.supportedModes.map((supportedMode) => (
                              <SelectItem key={supportedMode} value={supportedMode}>
                                {modeLabel(supportedMode)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">{modeDescription(mode)}</p>
                        {managed && <ManagedSettingHint />}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
          <AssistantSaveFeedback state={saveState} onReload={reloadLatest} />
          <div className="flex justify-end">
            <Button
              type="button"
              className="min-h-11 sm:min-h-9"
              disabled={!dirty || saveState === 'saving'}
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
      )}
    </SettingsCard>
  )
}
