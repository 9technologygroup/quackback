/**
 * Server functions for workflows (support platform §4.6): the AI & Automation
 * manager's CRUD + lifecycle. Reads stay on routing.manage (workflows are part of
 * the routing surface); mutations gate on the dedicated workflow.manage key. Graph
 * + trigger settings are validated on write via the shared schemas so a malformed
 * automation is rejected at the boundary rather than stored and silently no-op'd
 * by the engine. Returns JSON-safe DTOs (Dates -> ISO, ids as plain strings), the
 * shape server functions serialize.
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import type { WorkflowId, WorkflowVersionId, ConversationId } from '@quackback/ids'
import { requireAuth } from './auth-helpers'
import { PERMISSIONS } from '@/lib/shared/permissions'
import type { Workflow, WorkflowClass, WorkflowStatus } from '@/lib/server/db'
import {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  setWorkflowStatus,
  softDeleteWorkflow,
} from '@/lib/server/domains/workflows/workflow.service'
import {
  listWorkflowVersions,
  getWorkflowVersion,
  type WorkflowVersionRow,
} from '@/lib/server/domains/workflows/workflow-versions'
import {
  previewWorkflow,
  type WorkflowPreviewResult,
  type WorkflowPreviewTraceEntry,
} from '@/lib/server/domains/workflows/workflow-preview'

export type { WorkflowPreviewResult, WorkflowPreviewTraceEntry }
import type { WorkflowGraph } from '@/lib/server/domains/workflows/graph'
import {
  workflowGraphSchema,
  triggerSettingsSchema,
  triggerTypeSchema,
  classRestrictedNodeIssue,
  type ValidatedWorkflowGraph,
} from '@/lib/server/domains/workflows/workflow.schemas'

// createServerFn constrains returns to serializable types, so the jsonb fields
// are typed as JSON (not Record<string, unknown> — `unknown` isn't provably
// serializable). The stored jsonb is JSON at runtime, so the cast is safe.
type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }
type JsonObject = { [k: string]: JsonValue }

export interface WorkflowDTO {
  id: string
  name: string
  class: WorkflowClass
  status: WorkflowStatus
  sortOrder: number
  triggerType: string
  triggerSettings: JsonObject
  graph: JsonObject
  createdBy: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

function serializeWorkflow(w: Workflow): WorkflowDTO {
  return {
    id: w.id,
    name: w.name,
    class: w.class,
    status: w.status,
    sortOrder: w.sortOrder,
    triggerType: w.triggerType,
    triggerSettings: w.triggerSettings as JsonObject,
    graph: w.graph as JsonObject,
    createdBy: w.createdBy,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
    deletedAt: w.deletedAt ? w.deletedAt.toISOString() : null,
  }
}

/** The validated graph carries plain-string ids; the branded WorkflowGraph is
 *  satisfied by them at runtime (validation already fixed the shape). */
const toGraph = (g: ValidatedWorkflowGraph | undefined): WorkflowGraph | undefined =>
  g as WorkflowGraph | undefined

const workflowClass = z.enum(['customer_facing', 'background'])
const createSchema = z.object({
  name: z.string().min(1).max(120),
  class: workflowClass,
  triggerType: triggerTypeSchema,
  triggerSettings: triggerSettingsSchema.optional(),
  graph: workflowGraphSchema.optional(),
  sortOrder: z.number().int().optional(),
})
const updateSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120).optional(),
  class: workflowClass.optional(),
  triggerType: triggerTypeSchema.optional(),
  triggerSettings: triggerSettingsSchema.optional(),
  graph: workflowGraphSchema.optional(),
  sortOrder: z.number().int().optional(),
})
const setStatusSchema = z.object({ id: z.string(), status: z.enum(['draft', 'live', 'paused']) })
const idSchema = z.object({ id: z.string() })

export const listWorkflowsFn = createServerFn({ method: 'GET' }).handler(async () => {
  await requireAuth({ permission: PERMISSIONS.ROUTING_MANAGE })
  return (await listWorkflows()).map(serializeWorkflow)
})

export const getWorkflowFn = createServerFn({ method: 'GET' })
  .validator(idSchema)
  .handler(async ({ data }): Promise<WorkflowDTO | null> => {
    await requireAuth({ permission: PERMISSIONS.ROUTING_MANAGE })
    const wf = await getWorkflow(data.id as WorkflowId)
    return wf ? serializeWorkflow(wf) : null
  })

export const createWorkflowFn = createServerFn({ method: 'POST' })
  .validator(createSchema)
  .handler(async ({ data }): Promise<WorkflowDTO> => {
    const ctx = await requireAuth({ permission: PERMISSIONS.WORKFLOW_MANAGE })
    // Class rule for parking blocks (Phase C, slice C-6): both fields are
    // already in hand on create (class is required, not optional, on
    // createSchema), so no extra read is needed here — see updateWorkflowFn
    // for why an update needs one.
    if (data.graph) {
      const issue = classRestrictedNodeIssue(data.graph, data.class)
      if (issue) throw new Error(issue)
    }
    return serializeWorkflow(
      await createWorkflow({
        name: data.name,
        class: data.class,
        triggerType: data.triggerType,
        triggerSettings: data.triggerSettings,
        graph: toGraph(data.graph),
        sortOrder: data.sortOrder,
        createdBy: ctx.principal.id,
      })
    )
  })

export const updateWorkflowFn = createServerFn({ method: 'POST' })
  .validator(updateSchema)
  .handler(async ({ data }): Promise<WorkflowDTO> => {
    const ctx = await requireAuth({ permission: PERMISSIONS.WORKFLOW_MANAGE })
    // Class rule for parking blocks (Phase C, slice C-6): `class` is optional
    // on an update (a graph-only save doesn't necessarily touch it), so the
    // EFFECTIVE class a graph edit must be checked against is the incoming
    // one when present, else whatever the workflow is stored as today.
    if (data.graph) {
      const effectiveClass = data.class ?? (await getWorkflow(data.id as WorkflowId))?.class
      if (effectiveClass) {
        const issue = classRestrictedNodeIssue(data.graph, effectiveClass)
        if (issue) throw new Error(issue)
      }
    } else if (data.class) {
      // A class-only patch (no graph in this request) still changes the
      // EFFECTIVE class the STORED graph is checked against — e.g. flipping
      // an existing parking-block workflow from customer_facing to
      // background must be rejected too, not just a class+graph edit made in
      // the same request. Without this branch, `if (data.graph)` above never
      // runs and the flip silently lands on an unreachable parked run.
      const stored = await getWorkflow(data.id as WorkflowId)
      const storedNodes = stored?.graph?.nodes
      if (stored && Array.isArray(storedNodes)) {
        const issue = classRestrictedNodeIssue(
          { nodes: storedNodes as { id: string; type: string }[] },
          data.class
        )
        if (issue) throw new Error(issue)
      }
    }
    return serializeWorkflow(
      await updateWorkflow(
        data.id as WorkflowId,
        {
          name: data.name,
          class: data.class,
          triggerType: data.triggerType,
          triggerSettings: data.triggerSettings,
          graph: toGraph(data.graph),
          sortOrder: data.sortOrder,
        },
        ctx.principal.id
      )
    )
  })

export const setWorkflowStatusFn = createServerFn({ method: 'POST' })
  .validator(setStatusSchema)
  .handler(async ({ data }): Promise<WorkflowDTO> => {
    await requireAuth({ permission: PERMISSIONS.WORKFLOW_MANAGE })
    return serializeWorkflow(await setWorkflowStatus(data.id as WorkflowId, data.status))
  })

export const deleteWorkflowFn = createServerFn({ method: 'POST' })
  .validator(idSchema)
  .handler(async ({ data }): Promise<{ id: string }> => {
    await requireAuth({ permission: PERMISSIONS.WORKFLOW_MANAGE })
    await softDeleteWorkflow(data.id as WorkflowId)
    return { id: data.id }
  })

// --- Version history + rollback (support platform §4.6 version history +
// rollback) ---

export interface WorkflowVersionDTO {
  id: string
  workflowId: string
  name: string
  triggerType: string
  /** Node/edge counts derived from the snapshot's graph — cheap summary
   *  fields for the history list, not the graph itself (the sheet only ever
   *  shows a summary; restoring re-reads the full row server-side). */
  nodeCount: number
  edgeCount: number
  createdBy: string | null
  createdByName: string | null
  createdAt: string
}

/** Node/edge counts off a stored (already-valid) graph shape, read
 *  defensively like every other graph reader in this domain — a malformed
 *  shape just counts as empty rather than throwing. */
function graphCounts(graph: unknown): { nodeCount: number; edgeCount: number } {
  const g = graph as { nodes?: unknown[]; edges?: unknown[] } | null
  return {
    nodeCount: Array.isArray(g?.nodes) ? g.nodes.length : 0,
    edgeCount: Array.isArray(g?.edges) ? g.edges.length : 0,
  }
}

function serializeWorkflowVersion(v: WorkflowVersionRow): WorkflowVersionDTO {
  const { nodeCount, edgeCount } = graphCounts(v.graph)
  return {
    id: v.id,
    workflowId: v.workflowId,
    name: v.name,
    triggerType: v.triggerType,
    nodeCount,
    edgeCount,
    createdBy: v.createdBy,
    createdByName: v.createdByName,
    createdAt: v.createdAt.toISOString(),
  }
}

const workflowIdOnlySchema = z.object({ workflowId: z.string() })

/** A workflow's version history, newest first — the History sheet's list. */
export const listWorkflowVersionsFn = createServerFn({ method: 'GET' })
  .validator(workflowIdOnlySchema)
  .handler(async ({ data }): Promise<WorkflowVersionDTO[]> => {
    await requireAuth({ permission: PERMISSIONS.ROUTING_MANAGE })
    const rows = await listWorkflowVersions(data.workflowId as WorkflowId)
    return rows.map(serializeWorkflowVersion)
  })

const restoreWorkflowVersionSchema = z.object({
  workflowId: z.string(),
  versionId: z.string(),
})

/**
 * Roll a workflow back to an older saved version: loads the snapshot and
 * applies it via the SAME updateWorkflow path (and the same updateSchema +
 * classRestrictedNodeIssue validation) an ordinary save runs, so a version
 * whose shape predates a since-tightened schema is still caught rather than
 * silently corrupting the live workflow. Only name/triggerType/
 * triggerSettings/graph are restored — class, sortOrder, and (crucially)
 * status are left exactly as they are today, so a restore never flips a
 * live/paused/draft workflow's lifecycle state. The restore itself produces
 * a fresh version row (an ordinary consequence of updateWorkflow), which is
 * correct: it's a new state the workflow has now been saved in.
 */
export const restoreWorkflowVersionFn = createServerFn({ method: 'POST' })
  .validator(restoreWorkflowVersionSchema)
  .handler(async ({ data }): Promise<WorkflowDTO> => {
    const ctx = await requireAuth({ permission: PERMISSIONS.WORKFLOW_MANAGE })
    const version = await getWorkflowVersion(data.versionId as WorkflowVersionId)
    if (!version || (version.workflowId as string) !== data.workflowId) {
      throw new Error('Workflow version not found')
    }
    const parsed = updateSchema.parse({
      id: data.workflowId,
      name: version.name,
      triggerType: version.triggerType,
      triggerSettings: version.triggerSettings,
      graph: version.graph,
    })
    // Same class-restricted-node check updateWorkflowFn runs for a graph
    // write — a restore never changes class, so the effective class is
    // whatever the workflow is stored as today.
    if (parsed.graph) {
      const effectiveClass = (await getWorkflow(parsed.id as WorkflowId))?.class
      if (effectiveClass) {
        const issue = classRestrictedNodeIssue(parsed.graph, effectiveClass)
        if (issue) throw new Error(issue)
      }
    }
    return serializeWorkflow(
      await updateWorkflow(
        parsed.id as WorkflowId,
        {
          name: parsed.name,
          triggerType: parsed.triggerType,
          triggerSettings: parsed.triggerSettings,
          graph: toGraph(parsed.graph),
        },
        ctx.principal.id
      )
    )
  })

// --- Dry-run preview (support platform §4.6 dry-run preview) ---

const previewSchema = z.object({ workflowId: z.string(), conversationId: z.string() })

/**
 * Dry-run a workflow against a real conversation: read-only (routing.manage,
 * same as every other read in this file), writes nothing. See
 * workflow-preview.ts's previewWorkflow for the read-only guarantee and the
 * trace it returns.
 */
export const previewWorkflowFn = createServerFn({ method: 'POST' })
  .validator(previewSchema)
  .handler(async ({ data }): Promise<WorkflowPreviewResult> => {
    await requireAuth({ permission: PERMISSIONS.ROUTING_MANAGE })
    return previewWorkflow({
      workflowId: data.workflowId as WorkflowId,
      conversationId: data.conversationId as ConversationId,
    })
  })
