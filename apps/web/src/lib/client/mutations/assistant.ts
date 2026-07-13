/** Revision-aware AI agent configuration and guidance mutations. */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AssistantGuidanceRuleId } from '@quackback/ids'
import type { AssistantRole } from '@/lib/shared/assistant/config'
import type { AssistantSurface } from '@/lib/shared/assistant/surfaces'
import {
  createGuidanceRuleFn,
  updateGuidanceRuleFn,
  deleteGuidanceRuleFn,
  reorderGuidanceRulesFn,
} from '@/lib/server/functions/assistant-guidance'
import {
  getAssistantSettingsFn,
  updateAssistantIdentityFn,
  updateAssistantVoiceFn,
  updateAssistantChannelsFn,
  updateAssistantToolControlsFn,
  updateWidgetAssistantDeploymentFn,
} from '@/lib/server/functions/assistant-settings'
import { assistantKeys } from '@/lib/client/queries/assistant'
import { settingsQueries } from '@/lib/client/queries/settings'

export interface GuidanceRuleInput {
  name: string
  appliesWhen: string | null
  instruction: string
  roles: AssistantRole[]
  /** Null means every eligible channel. */
  channels: AssistantSurface[] | null
  enabled: boolean
  priority: number
}

type AssistantSettings = Awaited<ReturnType<typeof getAssistantSettingsFn>>
type AssistantConfigResult = Pick<AssistantSettings, 'config' | 'revision'>

function setAssistantConfig(
  queryClient: ReturnType<typeof useQueryClient>,
  result: AssistantConfigResult
) {
  queryClient.setQueryData<AssistantSettings>(assistantKeys.settings(), (current) =>
    current ? { ...current, ...result } : current
  )
  void queryClient.invalidateQueries({ queryKey: assistantKeys.configChangelog() })
}

export function useCreateGuidanceRule() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: GuidanceRuleInput) => createGuidanceRuleFn({ data: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: assistantKeys.guidanceRules() })
      void queryClient.invalidateQueries({ queryKey: assistantKeys.configChangelog() })
    },
  })
}

export function useUpdateGuidanceRule() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<GuidanceRuleInput> & { id: AssistantGuidanceRuleId }) =>
      updateGuidanceRuleFn({ data: { id, ...input } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: assistantKeys.guidanceRules() })
      void queryClient.invalidateQueries({ queryKey: assistantKeys.configChangelog() })
    },
  })
}

export function useDeleteGuidanceRule() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: AssistantGuidanceRuleId) => deleteGuidanceRuleFn({ data: { id } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: assistantKeys.guidanceRules() })
      void queryClient.invalidateQueries({ queryKey: assistantKeys.configChangelog() })
    },
  })
}

export function useReorderGuidanceRules() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (ids: AssistantGuidanceRuleId[]) => reorderGuidanceRulesFn({ data: { ids } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: assistantKeys.guidanceRules() })
      void queryClient.invalidateQueries({ queryKey: assistantKeys.configChangelog() })
    },
  })
}

export function useUpdateAssistantIdentity() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: Parameters<typeof updateAssistantIdentityFn>[0]['data']) =>
      updateAssistantIdentityFn({ data }),
    onSuccess: (result) => setAssistantConfig(queryClient, result),
  })
}

export function useUpdateAssistantVoice() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: Parameters<typeof updateAssistantVoiceFn>[0]['data']) =>
      updateAssistantVoiceFn({ data }),
    onSuccess: (result) => setAssistantConfig(queryClient, result),
  })
}

export function useUpdateAssistantChannels() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: Parameters<typeof updateAssistantChannelsFn>[0]['data']) =>
      updateAssistantChannelsFn({ data }),
    onSuccess: (result) => setAssistantConfig(queryClient, result),
  })
}

export function useUpdateAssistantToolControls() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: Parameters<typeof updateAssistantToolControlsFn>[0]['data']) =>
      updateAssistantToolControlsFn({ data }),
    onSuccess: (result) => setAssistantConfig(queryClient, result),
  })
}

export function useUpdateWidgetAssistantDeployment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: Parameters<typeof updateWidgetAssistantDeploymentFn>[0]['data']) =>
      updateWidgetAssistantDeploymentFn({ data }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsQueries.widgetConfig().queryKey })
      void queryClient.invalidateQueries({ queryKey: assistantKeys.configChangelog() })
    },
  })
}
