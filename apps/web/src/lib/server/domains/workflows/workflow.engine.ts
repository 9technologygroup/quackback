/**
 * The workflow run engine (support platform §4.6, Slice 5d-i). runWorkflow takes
 * one workflow + a resolved condition snapshot, walks its graph, executes the
 * planned actions through the shared executor, and records the run + its timeline.
 * It is the single-workflow half of the dispatcher; the dispatcher (5d-ii) does
 * the human-actor gate, class split (customer_facing exclusive vs background
 * parallel), and frequency caps around it; durable-wait resume (5e) continues a
 * run from its cursor.
 *
 * Actions run under a service actor with admin authority — a workflow is
 * admin-configured automation acting on the workspace's behalf, mirroring the
 * full-API-key service principal. Each action is best-effort (a failure is logged
 * to the timeline and the run continues) so one bad action never strands a run.
 */
import {
  db,
  and,
  eq,
  inArray,
  sql,
  workflowRuns,
  workflowRunEvents,
  type Workflow,
  type WorkflowRun,
  type WorkflowRunState,
  type Transaction,
} from '@/lib/server/db'
import type { ConversationId, PrincipalId } from '@quackback/ids'
import type { Actor } from '@/lib/server/policy/types'
import { boundedServiceActor } from '@/lib/server/policy/service-actor'
import { PERMISSIONS, type PermissionKey } from '@/lib/shared/permissions'
import { logger } from '@/lib/server/logger'
import { isUniqueViolation } from '@/lib/server/utils'
import { applyAction } from './action.executor'
import { walkWorkflow, type WorkflowGraph, type WalkResult } from './graph'
import type { ConditionContext } from './condition.evaluator'
import { getWorkflow } from './workflow.service'
import { resolveConditionContext } from './condition.context'
import { scheduleWorkflowResume, readCursor, type WaitCursor } from './workflow-wait-queue'
import { hasFrequencyCap, claimFrequencyCapSlot } from './dispatcher.guards'

const log = logger.child({ component: 'workflow-engine' })

type Executor = typeof db | Transaction

/**
 * The bounded authority a workflow acts with: exactly the support actions the v1
 * catalogue applies, named explicitly rather than inheriting the whole admin role
 * — so the ceiling stays intentional and can't silently widen as admin grows. A
 * workflow can act on conversations but nothing outside support.
 */
const AUTOMATION_PERMISSIONS: ReadonlySet<PermissionKey> = new Set([
  PERMISSIONS.CONVERSATION_VIEW,
  PERMISSIONS.CONVERSATION_VIEW_ALL,
  PERMISSIONS.CONVERSATION_REPLY, // the canActAsAgent gate every action passes
  PERMISSIONS.CONVERSATION_ASSIGN,
  PERMISSIONS.CONVERSATION_SET_STATUS,
  PERMISSIONS.CONVERSATION_SET_TAGS,
  PERMISSIONS.CONVERSATION_SET_ATTRIBUTES,
  PERMISSIONS.SLA_MANAGE,
])

function workflowActor(): Actor {
  return boundedServiceActor(AUTOMATION_PERMISSIONS)
}

/** Read the stored graph defensively — a malformed shape becomes an empty graph
 *  (no nodes) so the walk simply produces nothing rather than throwing. */
function readGraph(workflow: Workflow): WorkflowGraph {
  const g = workflow.graph as unknown as Partial<WorkflowGraph> | null
  return {
    nodes: Array.isArray(g?.nodes) ? g!.nodes : [],
    edges: Array.isArray(g?.edges) ? g!.edges : [],
  }
}

/** Re-select a run by id. Used after a guarded settle update affects zero rows
 *  (someone else already moved the run on) to return its current row instead
 *  of the stale one the caller started from. Null when the row itself is gone
 *  (the conversation's cascade delete can remove it mid-settle). */
async function currentRun(runId: WorkflowRun['id']): Promise<WorkflowRun | null> {
  const [row] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1)
  return row ?? null
}

/**
 * Guarded settle: apply `patch` to a run only while it is still 'running'.
 * Returns null when the update affects zero rows — a concurrent writer
 * (interruptWaitingRuns, another settle) moved the run first and must win over
 * this settle rather than get overwritten. Every transition out of 'running'
 * goes through here, including the sweeper's stale-run settle.
 */
export async function settleRunning(
  runId: WorkflowRun['id'],
  patch: { state: WorkflowRunState; endedAt?: Date; cursor?: Record<string, unknown> }
): Promise<WorkflowRun | null> {
  const [settled] = await db
    .update(workflowRuns)
    .set(patch)
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.state, 'running')))
    .returning()
  return settled ?? null
}

/** Append to a run's timeline. Exported for the sweeper, which records its
 *  reconciliations (swept_stale, swept_rescheduled) the same way. `executor`
 *  defaults to `db`; runWorkflow passes its transaction so the 'started'
 *  event lands atomically with the run insert (see runWorkflow). */
export async function logRunEvent(
  runId: string,
  workflowId: string,
  subjectPrincipalId: PrincipalId | null,
  kind: string,
  executor: Executor = db
): Promise<void> {
  await executor.insert(workflowRunEvents).values({
    runId: runId as WorkflowRun['id'],
    workflowId: workflowId as Workflow['id'],
    subjectPrincipalId,
    kind,
  })
}

export interface RunWorkflowOptions {
  conversationId: ConversationId
  /** The person the run acts on, for per-person frequency caps. */
  subjectPrincipalId?: PrincipalId | null
}

/**
 * Run one workflow against a conversation. Walks the graph, runs the planned
 * actions, and records a workflow_run + timeline. Returns null when the walk
 * produces no actions and isn't waiting (an entry that matches nothing is a
 * silent no-op), OR when the customer_facing exclusive lock was lost, OR when
 * a frequency cap denied the run on its authoritative re-check (see below). On
 * a wait the run is left in state 'waiting' with the resume node in its
 * cursor; Slice 5e schedules the timer and resumes.
 *
 * customer_facing exclusive lock: the dispatcher's hasActiveCustomerFacingRun
 * is only a cheap pre-check, so two triggers can both pass it and race here —
 * the partial unique index on workflow_runs is the real lock, and losing that
 * race (a 23505) is treated the same as never having matched.
 *
 * Frequency cap: the dispatcher's frequencyCapAllows call is the same kind of
 * cheap pre-check (read-then-act), so two concurrent triggers for the same
 * (workflow, person) can both pass it before either's run is inserted,
 * over-running a 'once'/'once_per_days'/'n_total' cap. When the workflow has
 * a cap configured (hasFrequencyCap) and the trigger has a real subject to
 * key on, the run insert is preceded — inside the same transaction — by
 * dispatcher.guards.ts's claimFrequencyCapSlot: a pg_advisory_xact_lock keyed
 * on (workflowId, subjectPrincipalId) plus an authoritative re-check of the
 * cap. The lock serializes concurrent triggers for that exact pair
 * (session-reentrant, so it never self-deadlocks) and releases automatically
 * at commit or rollback. An uncapped workflow (the common case) skips the
 * lock entirely — nothing to race over, and paying a session-level lock on
 * every run would be pure overhead. The 'started' run event is logged inside
 * this same transaction (not after it, as before): a crash between the run
 * insert and the event insert used to leave a run the cap count couldn't
 * see, silently under-enforcing the cap.
 */
export async function runWorkflow(
  workflow: Workflow,
  ctx: ConditionContext,
  opts: RunWorkflowOptions
): Promise<WorkflowRun | null> {
  const plan = walkWorkflow(readGraph(workflow), ctx)
  if (plan.actions.length === 0 && plan.status !== 'waiting') return null

  const subjectPrincipalId = opts.subjectPrincipalId ?? null
  const gateOnFrequencyCap = subjectPrincipalId !== null && hasFrequencyCap(workflow)

  let run: WorkflowRun | null
  try {
    // In its own transaction (a savepoint if the caller is already in one) so a
    // lost race here rolls back just this insert, not a surrounding transaction
    // (a caught unique violation would otherwise abort an enclosing one).
    run = await db.transaction(async (tx) => {
      if (gateOnFrequencyCap && subjectPrincipalId) {
        if (!(await claimFrequencyCapSlot(tx, workflow, subjectPrincipalId))) return null
      }

      const [inserted] = await tx
        .insert(workflowRuns)
        .values({
          workflowId: workflow.id,
          conversationId: opts.conversationId,
          subjectPrincipalId,
          state: 'running',
          customerFacing: workflow.class === 'customer_facing',
        })
        .returning()
      // Same transaction as the run insert (see doc comment above) — not a
      // separate call after commit.
      await logRunEvent(inserted.id, workflow.id, subjectPrincipalId, 'started', tx)
      return inserted
    })
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    log.debug(
      { workflowId: workflow.id, conversationId: opts.conversationId },
      'customer_facing lock lost to a concurrent run, skipping'
    )
    return null
  }
  if (!run) return null // frequency cap denied on the authoritative re-check

  return applyPlanAndSettle(run, workflow, plan, opts.conversationId, subjectPrincipalId)
}

/**
 * Run the actions of a walk plan (best-effort) then settle the run: on a wait,
 * persist the resume cursor + schedule the durable timer and stay 'waiting'; else
 * mark it done. Shared by a fresh run and a resumed one.
 *
 * Both settle paths are guarded on `state = 'running'`: interruptWaitingRuns can
 * flip a run to 'interrupted' while its actions are still executing (a reply or
 * close lands mid-run), and that must win over this settle rather than get
 * overwritten. When the guarded update affects zero rows, the run was
 * interrupted concurrently: skip the run event and, on the waiting path, skip
 * scheduling a timer for a run that is no longer parked, and return the run's
 * current row instead of the stale one this function started with.
 */
async function applyPlanAndSettle(
  run: WorkflowRun,
  workflow: Workflow,
  plan: WalkResult,
  conversationId: ConversationId,
  subjectPrincipalId: PrincipalId | null
): Promise<WorkflowRun | null> {
  const actor = workflowActor()
  for (const action of plan.actions) {
    try {
      await applyAction(action, { conversationId, actor })
    } catch (err) {
      log.error({ err, action: action.type, workflowId: workflow.id }, 'workflow action failed')
      await logRunEvent(run.id, workflow.id, subjectPrincipalId, `action_failed:${action.type}`)
    }
  }

  if (plan.status === 'waiting') {
    const waitSeconds = plan.waitSeconds ?? 0
    // Increments on every park in this run (starting from 0) so each wait gets
    // its own durable-timer job id instead of colliding with an earlier one.
    const waitSeq = (readCursor(run).waitSeq ?? 0) + 1
    const cursor: WaitCursor = {
      resumeNodeId: plan.resumeNodeId ?? null,
      waitSeconds,
      waitSeq,
      waitStartedAt: new Date().toISOString(),
    }
    const waiting = await settleRunning(run.id, {
      state: 'waiting',
      cursor: cursor as unknown as Record<string, unknown>,
    })
    if (!waiting) return currentRun(run.id)
    await logRunEvent(run.id, workflow.id, subjectPrincipalId, 'waiting')
    await scheduleWorkflowResume(run.id, waitSeconds, waitSeq)
    return waiting
  }

  const done = await settleRunning(run.id, { state: 'done', endedAt: new Date() })
  if (!done) return currentRun(run.id)
  await logRunEvent(run.id, workflow.id, subjectPrincipalId, 'completed')
  return done
}

/** Settle a claimed run straight to a terminal state with no further actions
 *  (the vanished-workflow/paused-workflow/missing-cursor paths in
 *  resumeWorkflowRun). Guarded the same way as applyPlanAndSettle: a concurrent
 *  interrupt wins, and this returns the run's current row either way. */
async function settleTerminal(
  run: WorkflowRun,
  state: 'done' | 'interrupted'
): Promise<WorkflowRun | null> {
  const settled = await settleRunning(run.id, { state, endedAt: new Date() })
  return settled ?? (await currentRun(run.id))
}

/**
 * Resume a waiting run when its timer fires (called by the wait worker). Claims
 * the run first with an atomic waiting -> running update: a run already claimed
 * by another attempt, interrupted by a reply/close, or already handled affects
 * zero rows there and resumes nothing. The claim also stamps `resumedAt` into
 * the cursor in the same update — the sweeper measures a resumed run's
 * staleness from it, and a timer can fire far later than its scheduled time
 * (queue backlog, worker downtime), so the wait's fire time alone under-reports
 * how recently the run actually became live.
 *
 * Only a successful claim goes on to load the workflow, condition context, and
 * resume node. A paused (or otherwise non-live) workflow does not act post-wait
 * (pausing only stops new dispatches, not runs already parked) — except that a
 * run parked at a successor-less wait had nothing left to run and settles
 * 'done' regardless of status. The original triggering message is not
 * available post-wait, so a post-wait message condition sees none.
 *
 * Any throw after the claim reverts it (guarded, so a concurrent interrupt
 * still wins) and rethrows: without the revert, the retry's claim would match
 * zero rows (state is already 'running') and silently no-op, stranding the run
 * until the sweeper interrupts it — losing its post-wait actions.
 */
export async function resumeWorkflowRun(runId: WorkflowRun['id']): Promise<WorkflowRun | null> {
  const [claimed] = await db
    .update(workflowRuns)
    .set({
      state: 'running',
      cursor: sql`coalesce(${workflowRuns.cursor}, '{}'::jsonb) || jsonb_build_object('resumedAt', ${new Date().toISOString()}::text)`,
    })
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.state, 'waiting')))
    .returning()
  if (!claimed) return null // already claimed / interrupted / handled

  try {
    const resumeNodeId = readCursor(claimed).resumeNodeId ?? null
    if (!resumeNodeId) {
      // The wait had no successor: the run finished at the wait.
      return await settleTerminal(claimed, 'done')
    }

    const workflow = claimed.conversationId ? await getWorkflow(claimed.workflowId) : null
    if (workflow && workflow.status !== 'live') {
      return await settleTerminal(claimed, 'interrupted')
    }

    const ctx = claimed.conversationId
      ? await resolveConditionContext(claimed.conversationId)
      : null
    if (!workflow || !claimed.conversationId || !ctx) {
      // The workflow or conversation vanished while parked — settle it.
      return await settleTerminal(claimed, 'interrupted')
    }

    const plan = walkWorkflow(readGraph(workflow), ctx, resumeNodeId)
    return await applyPlanAndSettle(
      claimed,
      workflow,
      plan,
      claimed.conversationId,
      claimed.subjectPrincipalId
    )
  } catch (err) {
    await db
      .update(workflowRuns)
      .set({ state: 'waiting' })
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.state, 'running')))
    throw err
  }
}

/**
 * End every waiting run on a conversation (a reply or close interrupts pending
 * waits, per §4.6). Returns how many were interrupted. Wired into the reply/close
 * paths as a follow-up; the wait worker also re-checks state, so a late timer on
 * an interrupted run is already a no-op.
 */
export async function interruptWaitingRuns(conversationId: ConversationId): Promise<number> {
  const interrupted = await db
    .update(workflowRuns)
    .set({ state: 'interrupted', endedAt: new Date() })
    .where(
      and(
        eq(workflowRuns.conversationId, conversationId),
        inArray(workflowRuns.state, ['running', 'waiting'])
      )
    )
    .returning({ id: workflowRuns.id })
  return interrupted.length
}
