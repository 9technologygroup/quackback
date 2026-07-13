import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { actorFromAuth } from '@/lib/server/audit/log'
import {
  assistantChannelsUpdateSchema,
  assistantIdentityUpdateSchema,
  assistantToolControlsUpdateSchema,
  assistantVoiceUpdateSchema,
} from '@/lib/server/domains/settings/settings.assistant'
import { logger } from '@/lib/server/logger'
import { PERMISSIONS } from '@/lib/shared/permissions'
import { requireAuth } from './auth-helpers'
import { z } from 'zod'

const log = logger.child({ component: 'assistant-settings' })

export const getAssistantSettingsFn = createServerFn({ method: 'GET' }).handler(async () => {
  log.debug('fetch assistant settings')
  await requireAuth({ permission: PERMISSIONS.ASSISTANT_MANAGE })
  const { getAssistantSettings } = await import('@/lib/server/domains/settings/settings.assistant')
  return getAssistantSettings()
})

function configActor(ctx: Awaited<ReturnType<typeof requireAuth>>) {
  return { ...actorFromAuth(ctx), headers: getRequestHeaders() }
}

export const updateAssistantIdentityFn = createServerFn({ method: 'POST' })
  .validator(assistantIdentityUpdateSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuth({ permission: PERMISSIONS.ASSISTANT_MANAGE })
    const { updateAssistantIdentity } =
      await import('@/lib/server/domains/settings/settings.assistant')
    return updateAssistantIdentity(data.expectedRevision, data.identity, configActor(ctx))
  })

export const updateAssistantVoiceFn = createServerFn({ method: 'POST' })
  .validator(assistantVoiceUpdateSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuth({ permission: PERMISSIONS.ASSISTANT_MANAGE })
    const { updateAssistantVoice } =
      await import('@/lib/server/domains/settings/settings.assistant')
    return updateAssistantVoice(data.expectedRevision, data.voice, configActor(ctx))
  })

export const updateAssistantChannelsFn = createServerFn({ method: 'POST' })
  .validator(assistantChannelsUpdateSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuth({ permission: PERMISSIONS.ASSISTANT_MANAGE })
    const { updateAssistantChannels } =
      await import('@/lib/server/domains/settings/settings.assistant')
    return updateAssistantChannels(data.expectedRevision, data.channels, configActor(ctx))
  })

export const updateAssistantToolControlsFn = createServerFn({ method: 'POST' })
  .validator(assistantToolControlsUpdateSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuth({ permission: PERMISSIONS.ASSISTANT_MANAGE })
    const { updateAssistantToolControls } =
      await import('@/lib/server/domains/settings/settings.assistant')
    return updateAssistantToolControls(data.expectedRevision, data.toolControls, configActor(ctx))
  })

export const updateWidgetAssistantDeploymentFn = createServerFn({ method: 'POST' })
  .validator(z.object({ enabled: z.boolean(), respond: z.boolean() }))
  .handler(async ({ data }) => {
    const ctx = await requireAuth({ permission: PERMISSIONS.ASSISTANT_MANAGE })
    const { updateWidgetAssistantDeployment } =
      await import('@/lib/server/domains/settings/settings.widget')
    return updateWidgetAssistantDeployment(data, configActor(ctx))
  })
