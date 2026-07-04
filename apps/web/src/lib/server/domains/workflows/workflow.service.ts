/**
 * Workflow CRUD (support platform §4.6, Slice 5b). Workflows are authored under AI
 * & Automation and dispatched by the engine; this is the storage + lifecycle
 * (draft -> live -> paused) + drag order. Pure CRUD, no gate here — the fn layer
 * gates on `workflow.manage`. The dispatcher reads live workflows for a trigger
 * via listLiveWorkflowsForTrigger; the graph itself is walked by graph.ts.
 */
import { db, eq, and, isNull, asc, workflows, type Workflow } from '@/lib/server/db'
import type { WorkflowClass, WorkflowStatus } from '@/lib/server/db'
import type { WorkflowId, PrincipalId } from '@quackback/ids'
import type { WorkflowGraph } from './graph'

export interface WorkflowInput {
  name: string
  class: WorkflowClass
  triggerType: string
  triggerSettings?: Record<string, unknown>
  graph?: WorkflowGraph
  sortOrder?: number
  createdBy?: PrincipalId | null
}

/** The graph is stored in a generic jsonb column; a WorkflowGraph is valid JSON
 *  but its typed node arrays don't structurally match the column's index type. */
const asJson = (graph: WorkflowGraph): Record<string, unknown> =>
  graph as unknown as Record<string, unknown>

export async function createWorkflow(input: WorkflowInput): Promise<Workflow> {
  const [row] = await db
    .insert(workflows)
    .values({
      name: input.name.trim(),
      class: input.class,
      triggerType: input.triggerType,
      triggerSettings: input.triggerSettings ?? {},
      graph: asJson(input.graph ?? { nodes: [], edges: [] }),
      sortOrder: input.sortOrder ?? 0,
      createdBy: input.createdBy ?? null,
    })
    .returning()
  return row
}

export async function listWorkflows(): Promise<Workflow[]> {
  return db
    .select()
    .from(workflows)
    .where(isNull(workflows.deletedAt))
    .orderBy(asc(workflows.sortOrder), asc(workflows.createdAt))
}

export async function getWorkflow(id: WorkflowId): Promise<Workflow | null> {
  const [row] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, id), isNull(workflows.deletedAt)))
    .limit(1)
  return row ?? null
}

export async function updateWorkflow(
  id: WorkflowId,
  patch: Partial<Omit<WorkflowInput, 'createdBy'>>
): Promise<Workflow> {
  const [row] = await db
    .update(workflows)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.class !== undefined ? { class: patch.class } : {}),
      ...(patch.triggerType !== undefined ? { triggerType: patch.triggerType } : {}),
      ...(patch.triggerSettings !== undefined ? { triggerSettings: patch.triggerSettings } : {}),
      ...(patch.graph !== undefined ? { graph: asJson(patch.graph) } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(workflows.id, id), isNull(workflows.deletedAt)))
    .returning()
  return row
}

/** Transition a workflow's lifecycle (draft -> live -> paused and back). */
export async function setWorkflowStatus(id: WorkflowId, status: WorkflowStatus): Promise<Workflow> {
  const [row] = await db
    .update(workflows)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(workflows.id, id), isNull(workflows.deletedAt)))
    .returning()
  return row
}

/** Soft-delete: runs cascade on a hard delete, so soft-delete preserves history. */
export async function softDeleteWorkflow(id: WorkflowId): Promise<void> {
  const now = new Date()
  await db
    .update(workflows)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(workflows.id, id), isNull(workflows.deletedAt)))
}

/**
 * The dispatcher's hot read: every live workflow for a trigger, in drag order.
 * customer_facing first-match and background parallel are both resolved by the
 * caller from this ordered list.
 */
export async function listLiveWorkflowsForTrigger(triggerType: string): Promise<Workflow[]> {
  return db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.triggerType, triggerType),
        eq(workflows.status, 'live'),
        isNull(workflows.deletedAt)
      )
    )
    .orderBy(asc(workflows.sortOrder), asc(workflows.createdAt))
}
