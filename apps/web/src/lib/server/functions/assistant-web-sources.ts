/**
 * Web-source CRUD server fns for the assistant knowledge settings. Gates on
 * either AI permission, same as snippets (assistant-snippets.ts) and guidance
 * rules (assistant-guidance.ts). Adding a source fetches the URL at write
 * time through the SSRF-guarded fetch (web-source.service.ts); with `crawl`
 * set, same-origin links are followed up to the page cap within the admin's
 * include/exclude path filters. The admin UI card that calls these is
 * deferred — this is the server-side CRUD foundation only.
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import type { AssistantWebSourceId } from '@quackback/ids'
import { logger } from '@/lib/server/logger'
import { requireAuth, assertAnyPermission } from './auth-helpers'
import { AI_ANY_PERMISSIONS } from '@/lib/shared/ai-permissions'

const log = logger.child({ component: 'assistant-web-sources' })

const addWebSourceSchema = z.object({
  url: z.url().max(2048),
  /** Follow same-origin links from the seed page, up to the page cap. */
  crawl: z.boolean().optional(),
  /** Path globs (`*` wildcard) a discovered link must match to be crawled. */
  includePaths: z.array(z.string().max(500)).max(50).optional(),
  /** Path globs a discovered link must not match; an exclude always wins. */
  excludePaths: z.array(z.string().max(500)).max(50).optional(),
  maxPages: z.number().int().min(1).max(100).optional(),
})

const webSourceIdSchema = z.object({ id: z.string() })

const setWebSourceEnabledSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
})

/** All web sources, enabled or not — the admin list shows every source. */
export const listWebSourcesFn = createServerFn({ method: 'GET' }).handler(async () => {
  log.debug('list web sources')
  assertAnyPermission(await requireAuth(), AI_ANY_PERMISSIONS)
  const { listWebSources } = await import('@/lib/server/domains/assistant/web-source.service')
  return listWebSources()
})

export const addWebSourceFn = createServerFn({ method: 'POST' })
  .validator(addWebSourceSchema)
  .handler(async ({ data }) => {
    log.info('add web source')
    const ctx = await requireAuth()
    assertAnyPermission(ctx, AI_ANY_PERMISSIONS)
    const { addWebSourceFromUrl } =
      await import('@/lib/server/domains/assistant/web-source.service')
    return addWebSourceFromUrl({
      url: data.url,
      createdById: ctx.principal.id,
      crawl: data.crawl,
      includePaths: data.includePaths,
      excludePaths: data.excludePaths,
      maxPages: data.maxPages,
    })
  })

export const setWebSourceEnabledFn = createServerFn({ method: 'POST' })
  .validator(setWebSourceEnabledSchema)
  .handler(async ({ data }) => {
    log.info('toggle web source')
    assertAnyPermission(await requireAuth(), AI_ANY_PERMISSIONS)
    const { setWebSourceEnabled } =
      await import('@/lib/server/domains/assistant/web-source.service')
    return setWebSourceEnabled(data.id as AssistantWebSourceId, data.enabled)
  })

export const deleteWebSourceFn = createServerFn({ method: 'POST' })
  .validator(webSourceIdSchema)
  .handler(async ({ data }) => {
    log.info('delete web source')
    assertAnyPermission(await requireAuth(), AI_ANY_PERMISSIONS)
    const { deleteWebSource } = await import('@/lib/server/domains/assistant/web-source.service')
    await deleteWebSource(data.id as AssistantWebSourceId)
    return { id: data.id }
  })
