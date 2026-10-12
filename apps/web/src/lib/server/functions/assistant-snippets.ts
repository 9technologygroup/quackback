/**
 * Snippet CRUD server fns for the assistant customization settings UI. Gates
 * on either AI permission, same as guidance rules (assistant-guidance.ts) and
 * assistant-settings.ts. The admin UI card that calls these, and wiring
 * assistant.snippet.* events into the AI-config audit changelog (the way
 * assistant.guidance.* events already are), are both deferred — this is the
 * server-side CRUD foundation only.
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import type { AssistantSnippetId } from '@quackback/ids'
import { logger } from '@/lib/server/logger'
import { requireAuth, assertAnyPermission } from './auth-helpers'
import { AI_ANY_PERMISSIONS } from '@/lib/shared/ai-permissions'

const log = logger.child({ component: 'assistant-snippets' })

const audienceSchema = z.enum(['public', 'team', 'internal'])

const createSnippetSchema = z.object({
  title: z.string().min(1).max(120),
  content: z.string().min(1).max(2000),
  audience: audienceSchema.optional(),
  enabled: z.boolean().optional(),
})

const updateSnippetSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(120).optional(),
  content: z.string().min(1).max(2000).optional(),
  audience: audienceSchema.optional(),
  enabled: z.boolean().optional(),
})

const deleteSnippetSchema = z.object({ id: z.string() })

/** All snippets, enabled or not — the admin list shows every snippet. */
export const listSnippetsFn = createServerFn({ method: 'GET' }).handler(async () => {
  log.debug('list snippets')
  assertAnyPermission(await requireAuth(), AI_ANY_PERMISSIONS)
  const { listSnippets } = await import('@/lib/server/domains/assistant/snippet.service')
  return listSnippets()
})

export const createSnippetFn = createServerFn({ method: 'POST' })
  .validator(createSnippetSchema)
  .handler(async ({ data }) => {
    log.info('create snippet')
    const ctx = await requireAuth()
    assertAnyPermission(ctx, AI_ANY_PERMISSIONS)
    const { createSnippet } = await import('@/lib/server/domains/assistant/snippet.service')
    return createSnippet({
      title: data.title,
      content: data.content,
      audience: data.audience,
      enabled: data.enabled,
      createdById: ctx.principal.id,
    })
  })

export const updateSnippetFn = createServerFn({ method: 'POST' })
  .validator(updateSnippetSchema)
  .handler(async ({ data }) => {
    log.info('update snippet')
    assertAnyPermission(await requireAuth(), AI_ANY_PERMISSIONS)
    const { updateSnippet } = await import('@/lib/server/domains/assistant/snippet.service')
    return updateSnippet(data.id as AssistantSnippetId, {
      title: data.title,
      content: data.content,
      audience: data.audience,
      enabled: data.enabled,
    })
  })

export const deleteSnippetFn = createServerFn({ method: 'POST' })
  .validator(deleteSnippetSchema)
  .handler(async ({ data }) => {
    log.info('delete snippet')
    assertAnyPermission(await requireAuth(), AI_ANY_PERMISSIONS)
    const { deleteSnippet } = await import('@/lib/server/domains/assistant/snippet.service')
    await deleteSnippet(data.id as AssistantSnippetId)
    return { id: data.id }
  })
