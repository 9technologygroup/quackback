/**
 * Agent skills CRUD. All gate on either AI permission.
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import type { SkillId } from '@quackback/ids'
import {
  skillInputSchema,
  skillUpdateInputSchema,
  type SkillDTO,
} from '@/lib/shared/assistant/skills'
import { logger } from '@/lib/server/logger'
import { recordAuditEvent, actorFromAuth } from '@/lib/server/audit/log'
import { requireAuth, assertAnyPermission, assertPermission } from './auth-helpers'
import { AI_ANY_PERMISSIONS, aiPermissionsForAssignments } from '@/lib/shared/ai-permissions'

const log = logger.child({ component: 'assistant-skills' })

export const listSkillsFn = createServerFn({ method: 'GET' }).handler(async () => {
  log.debug('list skills')
  assertAnyPermission(await requireAuth(), AI_ANY_PERMISSIONS)
  const { listSkills, toSkillDTO } = await import('@/lib/server/domains/assistant/skills.service')
  const rows = await listSkills()
  return { skills: rows.map(toSkillDTO) satisfies SkillDTO[] }
})

export const createSkillFn = createServerFn({ method: 'POST' })
  .validator(skillInputSchema)
  .handler(async ({ data }) => {
    log.info('create skill')
    const ctx = await requireAuth()
    assertAnyPermission(ctx, AI_ANY_PERMISSIONS)
    for (const needed of aiPermissionsForAssignments(data.assignments))
      assertPermission(ctx, needed)
    const { createSkill, toSkillDTO } =
      await import('@/lib/server/domains/assistant/skills.service')
    const row = await createSkill({ ...data, createdByPrincipalId: ctx.principal.id })
    await recordAuditEvent({
      event: 'assistant.skill.created',
      actor: actorFromAuth(ctx),
      headers: getRequestHeaders(),
      target: { type: 'skill', id: row.id },
      after: { name: row.name, assignments: row.assignments },
    })
    return toSkillDTO(row)
  })

export const updateSkillFn = createServerFn({ method: 'POST' })
  .validator(skillUpdateInputSchema)
  .handler(async ({ data }) => {
    log.info('update skill')
    const ctx = await requireAuth()
    assertAnyPermission(ctx, AI_ANY_PERMISSIONS)
    for (const needed of aiPermissionsForAssignments(data.assignments))
      assertPermission(ctx, needed)
    const { updateSkill, toSkillDTO } =
      await import('@/lib/server/domains/assistant/skills.service')
    const { id, ...input } = data
    const row = await updateSkill(id as SkillId, input)
    await recordAuditEvent({
      event: 'assistant.skill.updated',
      actor: actorFromAuth(ctx),
      headers: getRequestHeaders(),
      target: { type: 'skill', id },
      after: row ? { name: row.name, enabled: row.enabled } : null,
    })
    return row ? toSkillDTO(row) : null
  })

export const deleteSkillFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }) => {
    log.info('delete skill')
    const ctx = await requireAuth()
    assertAnyPermission(ctx, AI_ANY_PERMISSIONS)
    const { deleteSkill } = await import('@/lib/server/domains/assistant/skills.service')
    await deleteSkill(data.id as SkillId)
    await recordAuditEvent({
      event: 'assistant.skill.deleted',
      actor: actorFromAuth(ctx),
      headers: getRequestHeaders(),
      target: { type: 'skill', id: data.id },
    })
    return { id: data.id }
  })
