/**
 * Server functions for support reporting (§4.6, §7): SLA attainment + workflow
 * effectiveness over a date range, for the analytics dashboard. Read-only, gated
 * on analytics.view.
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import { requireAuth } from './auth-helpers'
import { PERMISSIONS } from '@/lib/shared/permissions'
import { slaAttainment } from '@/lib/server/domains/sla/sla-reporting'
import { workflowEffectiveness } from '@/lib/server/domains/workflows/workflow-reporting'

const rangeSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
})

export const slaAttainmentFn = createServerFn({ method: 'GET' })
  .validator(rangeSchema)
  .handler(async ({ data }) => {
    await requireAuth({ permission: PERMISSIONS.ANALYTICS_VIEW })
    return slaAttainment(new Date(data.from), new Date(data.to))
  })

export const workflowEffectivenessFn = createServerFn({ method: 'GET' })
  .validator(rangeSchema)
  .handler(async ({ data }) => {
    await requireAuth({ permission: PERMISSIONS.ANALYTICS_VIEW })
    // workflowId is a plain string over the wire (JSON-safe).
    return (await workflowEffectiveness(new Date(data.from), new Date(data.to))).map((w) => ({
      workflowId: w.workflowId as string,
      started: w.started,
      completed: w.completed,
      interrupted: w.interrupted,
      waiting: w.waiting,
    }))
  })
