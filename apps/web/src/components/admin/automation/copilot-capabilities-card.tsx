import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useIntl } from 'react-intl'
import { toast } from 'sonner'
import { SparklesIcon } from '@heroicons/react/24/outline'
import { SettingsCard } from '@/components/admin/settings/settings-card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { assistantQueries } from '@/lib/client/queries/assistant'
import { useUpdateAssistantCopilotCapabilities } from '@/lib/client/mutations/assistant'
import type { AssistantCopilotCapabilities } from '@/lib/shared/assistant/config'
import { isAssistantFieldManaged, ManagedSettingHint } from './assistant-form'

export function CopilotCapabilitiesCard() {
  const intl = useIntl()
  const settingsQuery = useQuery(assistantQueries.settings())
  const update = useUpdateAssistantCopilotCapabilities()
  const [capabilities, setCapabilities] = useState<AssistantCopilotCapabilities | null>(null)

  useEffect(() => {
    if (settingsQuery.data && !update.isPending) {
      setCapabilities(settingsQuery.data.config.agents.copilot.capabilities)
    }
  }, [settingsQuery.data, update.isPending])

  if (settingsQuery.isError) {
    return (
      <SettingsCard
        title={intl.formatMessage({
          id: 'automation.copilot.capabilities.title',
          defaultMessage: 'What Copilot does',
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

  if (!capabilities || settingsQuery.isPending) {
    return (
      <SettingsCard
        title={intl.formatMessage({
          id: 'automation.copilot.capabilities.title',
          defaultMessage: 'What Copilot does',
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
  const revision = settingsQuery.data.revision
  const qaManaged = isAssistantFieldManaged(managedPaths, 'agents.copilot.capabilities.qa')
  const draftsManaged = isAssistantFieldManaged(
    managedPaths,
    'agents.copilot.capabilities.suggestedReplies'
  )

  async function toggle(key: keyof AssistantCopilotCapabilities, next: boolean) {
    const previous = capabilities
    // A computed-key spread widens the known keys to optional, so re-assert the
    // exact capabilities shape (both fields are booleans the schema re-validates).
    const optimistic = { ...capabilities, [key]: next } as AssistantCopilotCapabilities
    setCapabilities(optimistic)
    try {
      await update.mutateAsync({ expectedRevision: revision, capabilities: optimistic })
    } catch {
      setCapabilities(previous)
      toast.error(
        intl.formatMessage({
          id: 'automation.copilot.capabilities.saveError',
          defaultMessage: 'Copilot capabilities could not be updated.',
        })
      )
    }
  }

  return (
    <SettingsCard
      title={intl.formatMessage({
        id: 'automation.copilot.capabilities.title',
        defaultMessage: 'What Copilot does',
      })}
      description={intl.formatMessage({
        id: 'automation.copilot.capabilities.description',
        defaultMessage: 'Choose how Copilot helps your team in the inbox.',
      })}
    >
      <div className="space-y-4">
        <div className="divide-y divide-border/60">
          <div className="flex items-start gap-3 py-4 first:pt-0">
            <div className="min-w-0 flex-1">
              <label htmlFor="copilot-qa" className="text-sm font-medium">
                {intl.formatMessage({
                  id: 'automation.copilot.capabilities.qa.label',
                  defaultMessage: 'Answer questions',
                })}
              </label>
              <p className="mt-1 text-xs text-muted-foreground">
                {intl.formatMessage({
                  id: 'automation.copilot.capabilities.qa.help',
                  defaultMessage:
                    'Teammates can ask Copilot about a conversation and your knowledge sources.',
                })}
              </p>
              {qaManaged && <ManagedSettingHint />}
            </div>
            <Switch
              id="copilot-qa"
              checked={capabilities.qa}
              disabled={qaManaged || update.isPending}
              onCheckedChange={(next) => void toggle('qa', next)}
            />
          </div>

          <div className="flex items-start gap-3 py-4 last:pb-0">
            <div className="min-w-0 flex-1">
              <label htmlFor="copilot-drafts" className="text-sm font-medium">
                {intl.formatMessage({
                  id: 'automation.copilot.capabilities.drafts.label',
                  defaultMessage: 'Suggest reply drafts',
                })}
              </label>
              <p className="mt-1 text-xs text-muted-foreground">
                {intl.formatMessage({
                  id: 'automation.copilot.capabilities.drafts.help',
                  defaultMessage:
                    'Copilot offers a customer-facing draft for a teammate to review. Drafts use the Agent’s voice, not a separate tone.',
                })}
              </p>
              {draftsManaged && <ManagedSettingHint />}
            </div>
            <Switch
              id="copilot-drafts"
              checked={capabilities.suggestedReplies}
              disabled={draftsManaged || update.isPending}
              onCheckedChange={(next) => void toggle('suggestedReplies', next)}
            />
          </div>
        </div>

        <div className="flex items-start gap-2.5 rounded-lg bg-muted/50 px-3 py-2.5 text-[13px] text-muted-foreground">
          <SparklesIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <p>
            {intl.formatMessage({
              id: 'automation.copilot.capabilities.zeroConfig',
              defaultMessage:
                'Copilot works out of the box. Every setting already has a sensible default, so you only change what you want to.',
            })}
          </p>
        </div>
      </div>
    </SettingsCard>
  )
}
