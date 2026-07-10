/**
 * Zod validation for a workflow graph + trigger settings (support platform §4.6).
 * The engine reads a stored graph defensively (a malformed shape just produces
 * nothing), but authoring should fail loud, so the fn layer validates writes
 * here. The schemas mirror the domain types (WorkflowAction / WorkflowCondition /
 * WorkflowNode / WorkflowGraph); a compile-time check at the bottom pins them to
 * the types so the two can't silently drift.
 *
 * CALIBRATION: the builder's "Edit as JSON" mode is a deliberately lossless
 * escape hatch that can store graphs the visual editor can't render (multiple
 * triggers, merged paths, cycles, unreachable nodes) — the runtime walker
 * (graph.ts) tolerates every one of those (a visited-set ends a re-entered
 * path; a missing successor just ends a path early). None of that is rejected
 * here. Validation only hard-rejects shapes the walker can never make sense of
 * at runtime: a duplicate node id, an edge pointing at a node id that doesn't
 * exist, a wait longer than MAX_WAIT_SECONDS, and a branch edge whose `branch`
 * key isn't one the node declares. Applies to writes only (create/update) —
 * an already-stored graph is never re-validated on read.
 */
import { z } from 'zod'
import {
  ATTRIBUTE_FIELD_PREFIX,
  CONDITION_FIELDS,
  type WorkflowCondition,
} from './condition.evaluator'
import { DISPATCHABLE_TRIGGER_TYPES } from '@/lib/shared/workflow-trigger-types'

const conditionOperator = z.enum([
  'eq',
  'neq',
  'contains',
  'not_contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'includes_any',
  'excludes_all',
  'is_set',
  'is_empty',
])

const conditionLeaf = z.object({
  // Validated against the evaluator's field catalogue so a typo is caught on
  // save. Attribute predicates are dynamic (conversation.attr.<key>) so they
  // pass by prefix instead of the static enum.
  field: z.union([
    z.enum(CONDITION_FIELDS),
    z
      .string()
      .refine(
        (f) => f.startsWith(ATTRIBUTE_FIELD_PREFIX) && f.length > ATTRIBUTE_FIELD_PREFIX.length,
        { message: 'Unknown condition field' }
      ),
  ]),
  op: conditionOperator,
  value: z.unknown().optional(),
})

// Recursive: a group nests conditions under all / any. The group is strict so a
// typo'd leaf (bad field) can't slip through as an empty group when its unknown
// keys would otherwise be stripped.
const conditionSchema: z.ZodType<WorkflowCondition> = z.lazy(() =>
  z.union([
    conditionLeaf,
    z
      .object({
        all: z.array(conditionSchema).optional(),
        any: z.array(conditionSchema).optional(),
      })
      .strict(),
  ])
)

/** A wait (or snooze duration) longer than this is almost certainly a
 *  misconfiguration (a unit mixup, e.g. minutes typed into a "days" field)
 *  rather than an intentional pause — the floor stays >= 0 (unchanged) for a
 *  same-instant wait. */
export const MAX_WAIT_SECONDS = 90 * 24 * 60 * 60 // 90 days

// Two shapes share the 'snooze' action type (a plain z.union, not a
// discriminatedUnion, since discriminatedUnion requires a unique literal per
// branch and both branches are 'snooze'): the legacy absolute form
// (untilIso, an ISO string, or null for "until they reply") and the relative
// form (seconds, resolved to now + seconds at execution time — see
// action.executor.ts). `.strict()` on each branch means a payload carrying
// both keys matches neither (same "exactly one" trick as item-ref.schema.ts),
// so a stored graph can never be ambiguous about which form it's in.
const snoozeActionSchema = z.union([
  z.object({ type: z.literal('snooze'), untilIso: z.string().datetime().nullable() }).strict(),
  z
    .object({ type: z.literal('snooze'), seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS) })
    .strict(),
])

const actionSchema = z.union([
  z.object({ type: z.literal('assign_agent'), principalId: z.string().min(1) }),
  z.object({ type: z.literal('assign_team'), teamId: z.string().min(1) }),
  z.object({ type: z.literal('add_tag'), tagId: z.string().min(1) }),
  z.object({ type: z.literal('remove_tag'), tagId: z.string().min(1) }),
  z.object({
    type: z.literal('set_priority'),
    priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']),
  }),
  snoozeActionSchema,
  z.object({ type: z.literal('close') }),
  z.object({ type: z.literal('apply_sla'), policyId: z.string().min(1) }),
  z.object({ type: z.literal('set_attribute'), key: z.string().min(1), value: z.unknown() }),
])

const nodeSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string().min(1), type: z.literal('trigger') }),
  z.object({ id: z.string().min(1), type: z.literal('action'), action: actionSchema }),
  z.object({ id: z.string().min(1), type: z.literal('condition'), condition: conditionSchema }),
  z.object({
    id: z.string().min(1),
    type: z.literal('branch'),
    branches: z.array(z.object({ key: z.string().min(1), condition: conditionSchema })),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('wait'),
    seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS),
  }),
])

const edgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  branch: z.string().optional(),
})

// Message builders for the structural checks below, shared with the client's
// validateGraph (workflow-graph.ts), which re-checks a graph before it's ever
// sent here. Exporting these keeps the wording from drifting between the two
// call sites instead of each hand-copying the other's string; the client
// prefixes an `edges[i]:`/`nodes[i]:` index these zod issues don't need
// (theirs carries a `path` instead).
export function duplicateStepIdMessage(id: string): string {
  return `Duplicate step id "${id}"`
}
export function missingStepMessage(id: string): string {
  return `Connection references a missing step "${id}"`
}
export function undeclaredBranchPathMessage(from: string, branch: string): string {
  return `Branch "${from}" has a connection for an undeclared path "${branch}"`
}

export const workflowGraphSchema = z
  .object({
    nodes: z.array(nodeSchema).max(200),
    edges: z.array(edgeSchema).max(400),
  })
  .superRefine((graph, ctx) => {
    // Cross-node checks the per-node/per-edge schemas above can't express on
    // their own — the walker (graph.ts) can't run at all against these, so
    // they're the only structural rejections beyond individual node/edge shape.
    // Deliberately NOT checked here (see the module doc): trigger count, merges,
    // cycles, unreachable nodes, unlabeled/dangling branch edges — the walker
    // tolerates all of those.
    const nodeIds = new Set<string>()
    for (let i = 0; i < graph.nodes.length; i++) {
      const node = graph.nodes[i]!
      if (nodeIds.has(node.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: duplicateStepIdMessage(node.id),
          path: ['nodes', i, 'id'],
        })
      }
      nodeIds.add(node.id)
    }

    const branchKeysByNodeId = new Map<string, Set<string>>()
    for (const node of graph.nodes) {
      if (node.type === 'branch') {
        branchKeysByNodeId.set(node.id, new Set(node.branches.map((b) => b.key)))
      }
    }

    for (let i = 0; i < graph.edges.length; i++) {
      const edge = graph.edges[i]!
      if (!nodeIds.has(edge.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: missingStepMessage(edge.from),
          path: ['edges', i, 'from'],
        })
      }
      if (!nodeIds.has(edge.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: missingStepMessage(edge.to),
          path: ['edges', i, 'to'],
        })
      }
      // A branch key the node doesn't declare can never be taken (the walker
      // matches branches by key), so it's dead weight at best and a stale
      // rename at worst. An edge with no branch key, or one leaving a
      // non-branch node, is left alone — the walker just never follows it.
      const declaredKeys = branchKeysByNodeId.get(edge.from)
      if (declaredKeys && edge.branch !== undefined && !declaredKeys.has(edge.branch)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: undeclaredBranchPathMessage(edge.from, edge.branch),
          path: ['edges', i, 'branch'],
        })
      }
    }
  })

/** A per-(workflow, person) run cap, read by dispatcher.guards.ts's
 *  frequencyCapAllows off `trigger_settings.frequencyCap`. 'once' and
 *  'once_per_days' with no days elapsed both allow only a first run;
 *  'once_per_days' keys that first run to a rolling window (a fresh run is
 *  allowed once `days` have passed since the last one) while 'n_total' caps
 *  the lifetime count instead of gating on recency. Kept in sync with the
 *  guard's local type by hand (dispatcher.guards.ts imports this one).
 *  Bounds mirror MAX_WAIT_SECONDS' rationale: generous but finite, so a typo
 *  (an extra zero) doesn't read as "unlimited" instead of a real cap. */
export const MAX_FREQUENCY_CAP_DAYS = 365
export const MAX_FREQUENCY_CAP_COUNT = 1000
const frequencyCapSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('unlimited') }),
  z.object({ type: z.literal('once') }),
  z.object({
    type: z.literal('once_per_days'),
    days: z.number().int().min(1).max(MAX_FREQUENCY_CAP_DAYS),
  }),
  z.object({
    type: z.literal('n_total'),
    count: z.number().int().min(1).max(MAX_FREQUENCY_CAP_COUNT),
  }),
])
export type FrequencyCap = z.infer<typeof frequencyCapSchema>

/** Trigger settings stay an open bag (channels, and whatever else the
 *  authoring surface adds later) — only `frequencyCap` gets a validated
 *  shape when present, via `.catchall(z.unknown())` rather than `.strict()`
 *  or a plain `z.record`, so an unrecognized key still round-trips instead
 *  of being rejected or silently dropped. */
export const triggerSettingsSchema = z
  .object({ frequencyCap: frequencyCapSchema.optional() })
  .catchall(z.unknown())

/** Which trigger types a workflow can actually be dispatched on — see
 *  lib/shared/workflow-trigger-types.ts for the canonical list and how it's
 *  kept in sync with the event bus. Without this, functions/workflows.ts used
 *  to accept any string up to 80 characters, so a typo'd triggerType saved
 *  cleanly and then simply never fired. */
export const triggerTypeSchema = z.enum(DISPATCHABLE_TRIGGER_TYPES)

/**
 * The validated graph, with plain-string ids. The domain WorkflowGraph uses
 * branded TypeIDs on action fields; a validated string satisfies them at runtime,
 * so callers cast this to WorkflowGraph at the boundary. Keep this schema in sync
 * with the WorkflowAction / WorkflowNode / WorkflowGraph domain types by hand —
 * the branded ids make a structural compile-time equality check impractical.
 */
export type ValidatedWorkflowGraph = z.infer<typeof workflowGraphSchema>
