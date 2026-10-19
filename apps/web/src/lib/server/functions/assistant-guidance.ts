/**
 * Guidance-rule CRUD and the tool catalogue projection for the assistant
 * customization settings UI. A guidance rule belongs to one agent and is gated on
 * that agent's AI permission; lists and the tool catalogue open to either; the tool list is read-only metadata about the same
 * catalogue prompt assembly and the approval pipeline consume.
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import type { AssistantGuidanceRuleId } from '@quackback/ids'
import {
  assistantGuidanceRuleInputSchema,
  assistantGuidanceRulePatchSchema,
} from '@/lib/shared/assistant/guidance'
import { logger } from '@/lib/server/logger'
import { recordAuditEvent, actorFromAuth } from '@/lib/server/audit/log'
import type { AssistantAgentKind } from '@/lib/shared/assistant/config'
import { requireAuth, assertAnyPermission, assertPermission } from './auth-helpers'
import { AI_ANY_PERMISSIONS, aiPermissionForAgent } from '@/lib/shared/ai-permissions'

const log = logger.child({ component: 'assistant-guidance' })

const createGuidanceRuleSchema = assistantGuidanceRuleInputSchema
const updateGuidanceRuleSchema = assistantGuidanceRulePatchSchema.extend({ id: z.string() })

const reorderGuidanceRulesSchema = z.object({
  ids: z.array(z.string()).min(1),
})

const deleteGuidanceRuleSchema = z.object({ id: z.string() })

/**
 * The caller must hold the AI permission of every agent the rules belong to
 * (and of `moveTo`, when a rule is being moved to another agent). A rule that
 * no longer exists is left to the service to report.
 */
async function assertCanEditRules(
  ctx: Awaited<ReturnType<typeof requireAuth>>,
  ids: string[],
  moveTo?: AssistantAgentKind
): Promise<void> {
  const { listGuidanceRules } = await import('@/lib/server/domains/assistant/guidance.service')
  const wanted = new Set(ids)
  const rules = await listGuidanceRules({ enabledOnly: false })
  const agents = new Set<AssistantAgentKind>(moveTo ? [moveTo] : [])
  for (const rule of rules) if (wanted.has(rule.id)) agents.add(rule.agent as AssistantAgentKind)
  if (agents.size === 0) assertAnyPermission(ctx, AI_ANY_PERMISSIONS)
  for (const agent of agents) assertPermission(ctx, aiPermissionForAgent(agent))
}

/** All guidance rules, enabled or not — the admin list shows every rule. */
export const listGuidanceRulesFn = createServerFn({ method: 'GET' }).handler(async () => {
  log.debug('list guidance rules')
  assertAnyPermission(await requireAuth(), AI_ANY_PERMISSIONS)
  const { listGuidanceRules, GUIDANCE_CHAR_BUDGET } =
    await import('@/lib/server/domains/assistant/guidance.service')
  const rules = await listGuidanceRules({ enabledOnly: false })
  return { rules, charBudget: GUIDANCE_CHAR_BUDGET }
})

export const createGuidanceRuleFn = createServerFn({ method: 'POST' })
  .validator(createGuidanceRuleSchema)
  .handler(async ({ data }) => {
    log.info('create guidance rule')
    const ctx = await requireAuth()
    assertPermission(ctx, aiPermissionForAgent(data.agent))
    const { createGuidanceRule } = await import('@/lib/server/domains/assistant/guidance.service')
    const rule = await createGuidanceRule({
      name: data.name,
      appliesWhen: data.appliesWhen,
      instruction: data.instruction,
      agent: data.agent,
      enabled: data.enabled,
      priority: data.priority,
      createdById: ctx.principal.id,
    })
    await recordAuditEvent({
      event: 'assistant.guidance.created',
      actor: actorFromAuth(ctx),
      headers: getRequestHeaders(),
      target: { type: 'assistant_guidance', id: rule.id },
      after: {
        name: rule.name,
        alwaysOn: rule.appliesWhen === null,
        enabled: rule.enabled,
        agent: rule.agent,
        priority: rule.priority,
      },
    })
    return rule
  })

export const updateGuidanceRuleFn = createServerFn({ method: 'POST' })
  .validator(updateGuidanceRuleSchema)
  .handler(async ({ data }) => {
    log.info('update guidance rule')
    const ctx = await requireAuth()
    const { updateGuidanceRule } = await import('@/lib/server/domains/assistant/guidance.service')
    await assertCanEditRules(ctx, [data.id], data.agent)
    const rule = await updateGuidanceRule(data.id as AssistantGuidanceRuleId, {
      name: data.name,
      appliesWhen: data.appliesWhen,
      instruction: data.instruction,
      agent: data.agent,
      enabled: data.enabled,
      priority: data.priority,
    })
    await recordAuditEvent({
      event: 'assistant.guidance.updated',
      actor: actorFromAuth(ctx),
      headers: getRequestHeaders(),
      target: { type: 'assistant_guidance', id: data.id },
      after: rule
        ? {
            name: rule.name,
            alwaysOn: rule.appliesWhen === null,
            enabled: rule.enabled,
            agent: rule.agent,
            priority: rule.priority,
          }
        : null,
    })
    return rule
  })

export const reorderGuidanceRulesFn = createServerFn({ method: 'POST' })
  .validator(reorderGuidanceRulesSchema)
  .handler(async ({ data }) => {
    log.info('reorder guidance rules')
    const ctx = await requireAuth()
    const { reorderGuidanceRules } = await import('@/lib/server/domains/assistant/guidance.service')
    await assertCanEditRules(ctx, data.ids)
    await reorderGuidanceRules(data.ids as AssistantGuidanceRuleId[])
    await recordAuditEvent({
      event: 'assistant.guidance.reordered',
      actor: actorFromAuth(ctx),
      headers: getRequestHeaders(),
      metadata: { count: data.ids.length },
    })
    return { ids: data.ids }
  })

export const deleteGuidanceRuleFn = createServerFn({ method: 'POST' })
  .validator(deleteGuidanceRuleSchema)
  .handler(async ({ data }) => {
    log.info('delete guidance rule')
    const ctx = await requireAuth()
    const { deleteGuidanceRule } = await import('@/lib/server/domains/assistant/guidance.service')
    await assertCanEditRules(ctx, [data.id])
    await deleteGuidanceRule(data.id as AssistantGuidanceRuleId)
    await recordAuditEvent({
      event: 'assistant.guidance.deleted',
      actor: actorFromAuth(ctx),
      headers: getRequestHeaders(),
      target: { type: 'assistant_guidance', id: data.id },
    })
    return { id: data.id }
  })

/** The projected shape of a tool spec — everything the settings UI needs, nothing model-facing. */
export interface AssistantToolSummary {
  name: string
  label: string
  description: string
  risk: 'read' | 'write'
}

/** The built-in tool catalogue projected for the settings UI. */
export const listAssistantToolsFn = createServerFn({ method: 'GET' }).handler(async () => {
  log.debug('list assistant tools')
  assertAnyPermission(await requireAuth(), AI_ANY_PERMISSIONS)
  const { resolveToolSpecs } = await import('@/lib/server/domains/assistant/assistant.toolspec')
  const specs = await resolveToolSpecs()
  // Core control tools (handoff/inability) are protocol primitives, not
  // workspace-listed capabilities. They stay in Quinn's catalogue but do not
  // appear in the admin surface.
  return specs
    .filter((spec) => spec.risk !== 'control')
    .map((spec): AssistantToolSummary => ({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      // The filter above removes control tools; spell the narrowing here
      // because Array.filter does not refine an object property union.
      risk: spec.risk === 'write' ? 'write' : 'read',
    }))
})
