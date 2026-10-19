/** Guidance Applied count and last-applied timestamp, gated on either AI permission. */
import { createServerFn } from '@tanstack/react-start'
import { logger } from '@/lib/server/logger'
import { requireAuth, assertAnyPermission } from './auth-helpers'
import { AI_ANY_PERMISSIONS } from '@/lib/shared/ai-permissions'

const log = logger.child({ component: 'assistant-guidance-stats' })

/** Per-rule application stats, keyed by guidance rule id. */
export const getGuidanceRuleStatsFn = createServerFn({ method: 'GET' }).handler(async () => {
  log.debug('fetch guidance rule stats')
  assertAnyPermission(await requireAuth(), AI_ANY_PERMISSIONS)
  const { getGuidanceRuleStats } = await import('@/lib/server/domains/assistant/guidance-stats')
  return await getGuidanceRuleStats()
})
