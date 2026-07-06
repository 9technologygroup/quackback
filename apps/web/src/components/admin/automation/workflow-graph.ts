/**
 * Client-side model for the workflow builder canvas (support platform §4.6).
 *
 * The stored graph JSON ({ nodes, edges }, validated server-side by
 * workflowGraphSchema) is the single source of truth; the canvas is a lossless
 * view over it. This module converts between that JSON and the path tree the
 * canvas renders (graphToTree / treeToGraph), validates JSON edits client-side
 * with the same rules the server enforces, and carries the field / operator /
 * action catalogues with display labels. Server catalogues are imported
 * type-only, so every catalogue here is compile-pinned to the server's: adding
 * a field or action server-side fails the typecheck until the editor knows it.
 */
import type { ValidatedWorkflowGraph } from '@/lib/server/domains/workflows/workflow.schemas'
import type { CONDITION_FIELDS } from '@/lib/server/domains/workflows/condition.evaluator'

export type { ConditionOperator } from '@/lib/server/domains/workflows/condition.evaluator'
import type { ConditionOperator } from '@/lib/server/domains/workflows/condition.evaluator'

// ---------------------------------------------------------------------------
// Graph JSON types (plain-string ids: the exact shape the save mutation takes)
// ---------------------------------------------------------------------------

export type WorkflowGraphJson = ValidatedWorkflowGraph
export type GraphNode = WorkflowGraphJson['nodes'][number]
export type GraphEdge = WorkflowGraphJson['edges'][number]
export type GraphAction = Extract<GraphNode, { type: 'action' }>['action']
export type ActionType = GraphAction['type']
export type GraphCondition = Extract<GraphNode, { type: 'condition' }>['condition']
export type ConditionField = (typeof CONDITION_FIELDS)[number]

type Priority = Extract<GraphAction, { type: 'set_priority' }>['priority']

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

// ---------------------------------------------------------------------------
// Catalogues (labels for the editor; Record keys keep them exhaustive)
// ---------------------------------------------------------------------------

export type ConditionValueKind = 'text' | 'number' | 'list' | 'boolean' | 'choice'

export interface ConditionFieldMeta {
  label: string
  kind: ConditionValueKind
  /** For kind 'choice': the allowed values. */
  options?: readonly { value: string; label: string }[]
  /** Placeholder for text / list inputs. */
  placeholder?: string
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
}
export const PRIORITIES = Object.keys(PRIORITY_LABELS) as Priority[]

const PRIORITY_OPTIONS = PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))

export const CONDITION_FIELD_META: Record<ConditionField, ConditionFieldMeta> = {
  'conversation.status': {
    label: 'Conversation status',
    kind: 'choice',
    // Mirrors CONVERSATION_STATUSES in @quackback/db/types.
    options: [
      { value: 'open', label: 'Open' },
      { value: 'snoozed', label: 'Snoozed' },
      { value: 'closed', label: 'Closed' },
    ],
  },
  'conversation.channel': {
    label: 'Channel',
    kind: 'choice',
    // Mirrors CHANNELS in @quackback/db/types.
    options: [
      { value: 'messenger', label: 'Messenger' },
      { value: 'email', label: 'Email' },
      { value: 'web_form', label: 'Web form' },
    ],
  },
  'conversation.priority': { label: 'Priority', kind: 'choice', options: PRIORITY_OPTIONS },
  'conversation.waiting_minutes': { label: 'Customer waiting (minutes)', kind: 'number' },
  // TODO: swap the raw-id inputs for tag / segment pickers.
  'conversation.tags': {
    label: 'Conversation tags',
    kind: 'list',
    placeholder: 'Tag IDs, comma-separated',
  },
  'message.body': { label: 'Message body', kind: 'text', placeholder: 'Text to match' },
  'message.sender': {
    label: 'Message sender',
    kind: 'choice',
    options: [
      { value: 'visitor', label: 'Customer' },
      { value: 'agent', label: 'Teammate' },
    ],
  },
  'person.segments': {
    label: 'Person segments',
    kind: 'list',
    placeholder: 'Segment IDs, comma-separated',
  },
  office_hours: { label: 'Within office hours', kind: 'boolean' },
  'csat.rating': { label: 'CSAT rating', kind: 'number' },
}

export const CONDITION_FIELD_LIST = Object.keys(CONDITION_FIELD_META) as ConditionField[]

export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  not_contains: "doesn't contain",
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  includes_any: 'includes any of',
  excludes_all: 'includes none of',
  is_set: 'is set',
  is_empty: 'is empty',
}

/** Operators that take no value (the value input is hidden and omitted). */
export const VALUELESS_OPERATORS: ReadonlySet<ConditionOperator> = new Set(['is_set', 'is_empty'])

/** The operators that make sense per value kind, in menu order. */
export const OPERATORS_BY_KIND: Record<ConditionValueKind, readonly ConditionOperator[]> = {
  text: ['contains', 'not_contains', 'eq', 'neq', 'is_set', 'is_empty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_set', 'is_empty'],
  list: ['includes_any', 'excludes_all', 'is_set', 'is_empty'],
  boolean: ['eq', 'neq'],
  choice: ['eq', 'neq', 'is_set', 'is_empty'],
}

export const ACTION_LABELS: Record<ActionType, string> = {
  assign_agent: 'Assign to teammate',
  assign_team: 'Assign to team',
  add_tag: 'Add tag',
  remove_tag: 'Remove tag',
  set_priority: 'Set priority',
  snooze: 'Snooze',
  close: 'Close conversation',
  apply_sla: 'Apply SLA policy',
  set_attribute: 'Set attribute',
}
export const ACTION_TYPES = Object.keys(ACTION_LABELS) as ActionType[]

// ---------------------------------------------------------------------------
// Trigger / class / status catalogues (workflow-level, not step-level): the
// fullscreen builder's top bar + trigger inspector share these.
// ---------------------------------------------------------------------------

export const TRIGGER_TYPES = [
  'conversation.created',
  'message.created',
  'conversation.status_changed',
  'conversation.assigned',
  'assistant.handed_off',
] as const
export type TriggerType = (typeof TRIGGER_TYPES)[number]

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  'conversation.created': 'New conversation',
  'message.created': 'Message received',
  'conversation.status_changed': 'Status changed',
  'conversation.assigned': 'Assigned to team or agent',
  'assistant.handed_off': 'AI agent handed off to a human',
}

/** Trigger label for a stored triggerType, tolerant of an unknown/legacy value. */
export function triggerLabel(triggerType: string): string {
  return (TRIGGER_LABELS as Record<string, string | undefined>)[triggerType] ?? triggerType
}

export const WORKFLOW_CLASSES = [
  {
    value: 'customer_facing',
    label: 'Customer-facing',
    description: 'Exclusive: only one customer-facing workflow runs per conversation.',
  },
  {
    value: 'background',
    label: 'Background',
    description: 'Parallel: runs silently alongside other workflows.',
  },
] as const
export type WorkflowClassValue = (typeof WORKFLOW_CLASSES)[number]['value']

export const WORKFLOW_STATUSES = ['draft', 'live', 'paused'] as const
export type WorkflowStatusValue = (typeof WORKFLOW_STATUSES)[number]

/** The channel checkboxes offered under a trigger (mirrors "conversation.channel"). */
export const TRIGGER_CHANNELS = CONDITION_FIELD_META['conversation.channel'].options!

/** A fresh action of the given type with editable defaults. */
export function defaultAction(type: ActionType): GraphAction {
  switch (type) {
    case 'assign_agent':
      return { type, principalId: '' }
    case 'assign_team':
      return { type, teamId: '' }
    case 'add_tag':
      return { type, tagId: '' }
    case 'remove_tag':
      return { type, tagId: '' }
    case 'set_priority':
      return { type, priority: 'medium' }
    case 'snooze':
      return { type, untilIso: null }
    case 'close':
      return { type }
    case 'apply_sla':
      return { type, policyId: '' }
    case 'set_attribute':
      return { type, key: '', value: '' }
  }
}

export function isConditionField(v: unknown): v is ConditionField {
  return typeof v === 'string' && v in CONDITION_FIELD_META
}
function isOperator(v: unknown): v is ConditionOperator {
  return typeof v === 'string' && v in OPERATOR_LABELS
}
function isActionType(v: unknown): v is ActionType {
  return typeof v === 'string' && v in ACTION_LABELS
}
function isPriority(v: unknown): v is Priority {
  return typeof v === 'string' && v in PRIORITY_LABELS
}

// ---------------------------------------------------------------------------
// The canvas tree: what the auto-layout renders. A path is a top-to-bottom
// list of steps; a branch step splits into labeled paths and is always the
// LAST step of its path (insertStep maintains the invariant).
// ---------------------------------------------------------------------------

export interface BranchPath {
  key: string
  condition: GraphCondition
  steps: TreeStep[]
}

export type TreeStep =
  | { id: string; kind: 'action'; action: GraphAction }
  | { id: string; kind: 'condition'; condition: GraphCondition }
  | { id: string; kind: 'wait'; seconds: number }
  | { id: string; kind: 'branch'; paths: BranchPath[] }

export interface WorkflowTree {
  triggerId: string
  steps: TreeStep[]
}

export function newTree(): WorkflowTree {
  return { triggerId: 'trigger', steps: [] }
}

function collectIds(steps: TreeStep[], into: Set<string>): void {
  for (const step of steps) {
    into.add(step.id)
    if (step.kind === 'branch') for (const p of step.paths) collectIds(p.steps, into)
  }
}

/** A readable id ("wait-2") that is unique across the whole tree. */
export function freshStepId(tree: WorkflowTree, kind: TreeStep['kind']): string {
  const used = new Set<string>([tree.triggerId])
  collectIds(tree.steps, used)
  let n = 1
  while (used.has(`${kind}-${n}`)) n++
  return `${kind}-${n}`
}

/** A fresh step of the given kind with a tree-unique id. `actionType` picks
 *  the initial action for an 'action' step (the step palette inserts a
 *  specific type directly, e.g. "Apply SLA policy" rather than a generic
 *  action the editor then has to be switched away from). */
export function createStep(
  tree: WorkflowTree,
  kind: TreeStep['kind'],
  actionType?: ActionType
): TreeStep {
  const id = freshStepId(tree, kind)
  switch (kind) {
    case 'action':
      return { id, kind, action: defaultAction(actionType ?? 'assign_agent') }
    case 'condition':
      return { id, kind, condition: {} }
    case 'branch':
      return {
        id,
        kind,
        paths: [
          { key: 'Path 1', condition: {}, steps: [] },
          { key: 'Path 2', condition: {}, steps: [] },
        ],
      }
    case 'wait':
      return { id, kind, seconds: 3600 }
  }
}

/**
 * Insert a step at `index`. Inserting a branch splits the path: the steps
 * after the insertion point move into the branch's first path, so no step
 * ever follows a branch within one path.
 */
export function insertStep(steps: TreeStep[], index: number, step: TreeStep): TreeStep[] {
  const head = steps.slice(0, index)
  const tail = steps.slice(index)
  if (step.kind !== 'branch' || tail.length === 0) return [...head, step, ...tail]
  const [first, ...rest] = step.paths
  const firstPath: BranchPath = first
    ? { ...first, steps: [...first.steps, ...tail] }
    : { key: 'Path 1', condition: {}, steps: tail }
  return [...head, { ...step, paths: [firstPath, ...rest] }]
}

/** Steps in a subtree, for "this deletes N steps" confirmations. */
export function countSteps(steps: TreeStep[]): number {
  let n = 0
  for (const step of steps) {
    n++
    if (step.kind === 'branch') for (const p of step.paths) n += countSteps(p.steps)
  }
  return n
}

// ---------------------------------------------------------------------------
// Graph validation. Mirrors workflowGraphSchema (the server re-validates on
// save either way); errors aim to be actionable, not zod-shaped.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

// Mirrors z.string().datetime(): UTC, seconds required, optional fraction.
const isUtcTimestamp = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) &&
  !Number.isNaN(Date.parse(v))

function validateCondition(v: unknown, where: string): string | null {
  if (!isRecord(v)) return `${where}: a condition must be an object`
  if ('field' in v) {
    if (!isConditionField(v.field)) return `${where}: unknown condition field "${String(v.field)}"`
    if (!isOperator(v.op)) return `${where}: unknown operator "${String(v.op)}"`
    return null
  }
  for (const key of Object.keys(v)) {
    if (key !== 'all' && key !== 'any')
      return `${where}: unexpected key "${key}" in a condition group`
  }
  for (const key of ['all', 'any'] as const) {
    const list = v[key]
    if (list === undefined) continue
    if (!Array.isArray(list)) return `${where}: "${key}" must be an array of conditions`
    for (let i = 0; i < list.length; i++) {
      const err = validateCondition(list[i], `${where}.${key}[${i}]`)
      if (err) return err
    }
  }
  return null
}

function validateAction(v: unknown, where: string): string | null {
  if (!isRecord(v)) return `${where}: the action must be an object`
  if (!isActionType(v.type)) return `${where}: unknown action "${String(v.type)}"`
  switch (v.type) {
    case 'assign_agent':
      return nonEmptyString(v.principalId) ? null : `${where}: choose a teammate to assign`
    case 'assign_team':
      return nonEmptyString(v.teamId) ? null : `${where}: choose a team to assign`
    case 'add_tag':
    case 'remove_tag':
      return nonEmptyString(v.tagId) ? null : `${where}: choose a tag`
    case 'set_priority':
      return isPriority(v.priority) ? null : `${where}: pick a priority`
    case 'snooze':
      return v.untilIso === null || isUtcTimestamp(v.untilIso)
        ? null
        : `${where}: snooze needs a UTC timestamp (e.g. 2026-08-01T09:00:00Z) or null`
    case 'close':
      return null
    case 'apply_sla':
      return nonEmptyString(v.policyId) ? null : `${where}: enter an SLA policy id`
    case 'set_attribute':
      return nonEmptyString(v.key) ? null : `${where}: enter an attribute key`
  }
}

/** Structural validation of an unknown value as a workflow graph. */
export function validateGraph(input: unknown): Result<WorkflowGraphJson> {
  if (!isRecord(input)) return fail('The graph must be an object with "nodes" and "edges"')
  const { nodes, edges } = input
  if (!Array.isArray(nodes)) return fail('"nodes" must be an array')
  if (!Array.isArray(edges)) return fail('"edges" must be an array')
  if (nodes.length > 200) return fail('A workflow can have at most 200 steps')
  if (edges.length > 400) return fail('A workflow can have at most 400 connections')

  for (let i = 0; i < nodes.length; i++) {
    const node: unknown = nodes[i]
    if (!isRecord(node)) return fail(`nodes[${i}] must be an object`)
    if (!nonEmptyString(node.id)) return fail(`nodes[${i}] needs a non-empty string id`)
    const where = `Step "${node.id}"`
    switch (node.type) {
      case 'trigger':
        break
      case 'action': {
        const err = validateAction(node.action, where)
        if (err) return fail(err)
        break
      }
      case 'condition': {
        const err = validateCondition(node.condition, where)
        if (err) return fail(err)
        break
      }
      case 'branch': {
        if (!Array.isArray(node.branches)) return fail(`${where}: "branches" must be an array`)
        for (let b = 0; b < node.branches.length; b++) {
          const br: unknown = node.branches[b]
          if (!isRecord(br) || !nonEmptyString(br.key)) {
            return fail(`${where}: every branch path needs a non-empty key`)
          }
          const err = validateCondition(br.condition, `${where} path "${br.key}"`)
          if (err) return fail(err)
        }
        break
      }
      case 'wait': {
        if (
          typeof node.seconds !== 'number' ||
          !Number.isInteger(node.seconds) ||
          node.seconds < 0
        ) {
          return fail(`${where}: "seconds" must be a whole number of seconds (0 or more)`)
        }
        break
      }
      default:
        return fail(`nodes[${i}]: unknown step type "${String(node.type)}"`)
    }
  }

  for (let i = 0; i < edges.length; i++) {
    const edge: unknown = edges[i]
    if (!isRecord(edge) || !nonEmptyString(edge.from) || !nonEmptyString(edge.to)) {
      return fail(`edges[${i}] needs "from" and "to" step ids`)
    }
    if (edge.branch !== undefined && typeof edge.branch !== 'string') {
      return fail(`edges[${i}]: "branch" must be a string when present`)
    }
  }

  // Structure fully checked above; the cast narrows the JSON to the graph shape.
  return { ok: true, value: input as unknown as WorkflowGraphJson }
}

/** Parse + validate JSON text (the "Edit as JSON" mode and stored graphs). */
export function parseWorkflowGraphText(text: string): Result<WorkflowGraphJson> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return fail(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  return validateGraph(parsed)
}

// ---------------------------------------------------------------------------
// Graph <-> tree. graphToTree fails (with a reason) on shapes the auto-layout
// cannot show: no/multiple triggers, merges, cycles, unreachable steps. Those
// stay editable as JSON; nothing is silently dropped.
// ---------------------------------------------------------------------------

export function graphToTree(graph: WorkflowGraphJson): Result<WorkflowTree> {
  if (graph.nodes.length === 0) return { ok: true, value: newTree() }

  const byId = new Map<string, GraphNode>()
  for (const node of graph.nodes) {
    if (byId.has(node.id)) return fail(`two steps share the id "${node.id}"`)
    byId.set(node.id, node)
  }

  const triggers = graph.nodes.filter((n) => n.type === 'trigger')
  if (triggers.length === 0) return fail('the graph has no trigger step')
  if (triggers.length > 1) return fail('the graph has more than one trigger step')
  const trigger = triggers[0]!

  const incoming = new Map<string, number>()
  const outgoing = new Map<string, GraphEdge[]>()
  for (const edge of graph.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      return fail(`a connection references a missing step ("${edge.from}" to "${edge.to}")`)
    }
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    const outs = outgoing.get(edge.from) ?? []
    outs.push(edge)
    outgoing.set(edge.from, outs)
  }

  if ((incoming.get(trigger.id) ?? 0) > 0) return fail('the trigger has an incoming connection')
  for (const node of graph.nodes) {
    if (node.type !== 'trigger' && (incoming.get(node.id) ?? 0) !== 1) {
      return fail(`step "${node.id}" needs exactly one incoming connection`)
    }
  }

  const visited = new Set<string>([trigger.id])

  const singleSuccessor = (node: GraphNode): Result<string | undefined> => {
    const outs = outgoing.get(node.id) ?? []
    if (outs.some((e) => e.branch !== undefined)) {
      return fail(`step "${node.id}" has a labeled connection but is not a branch`)
    }
    if (outs.length > 1) return fail(`step "${node.id}" has more than one outgoing connection`)
    return { ok: true, value: outs[0]?.to }
  }

  const walkFrom = (startId: string | undefined): Result<TreeStep[]> => {
    const steps: TreeStep[] = []
    let currentId = startId
    while (currentId !== undefined) {
      if (visited.has(currentId)) return fail('the graph contains a cycle')
      visited.add(currentId)
      const node = byId.get(currentId)!
      if (node.type === 'trigger') return fail('a trigger appears in the middle of a path')
      if (node.type === 'branch') {
        const keys = new Set(node.branches.map((b) => b.key))
        if (keys.size !== node.branches.length) {
          return fail(`branch "${node.id}" has duplicate path keys`)
        }
        const edgeByKey = new Map<string, GraphEdge>()
        for (const edge of outgoing.get(node.id) ?? []) {
          if (edge.branch === undefined) {
            return fail(`branch "${node.id}" has an unlabeled outgoing connection`)
          }
          if (!keys.has(edge.branch)) {
            return fail(`branch "${node.id}" has a connection for an unknown path "${edge.branch}"`)
          }
          if (edgeByKey.has(edge.branch)) {
            return fail(`branch "${node.id}" has two connections for path "${edge.branch}"`)
          }
          edgeByKey.set(edge.branch, edge)
        }
        const paths: BranchPath[] = []
        for (const b of node.branches) {
          const sub = walkFrom(edgeByKey.get(b.key)?.to)
          if (!sub.ok) return sub
          paths.push({ key: b.key, condition: b.condition, steps: sub.value })
        }
        steps.push({ id: node.id, kind: 'branch', paths })
        return { ok: true, value: steps }
      }
      const next = singleSuccessor(node)
      if (!next.ok) return next
      steps.push(
        node.type === 'action'
          ? { id: node.id, kind: 'action', action: node.action }
          : node.type === 'condition'
            ? { id: node.id, kind: 'condition', condition: node.condition }
            : { id: node.id, kind: 'wait', seconds: node.seconds }
      )
      currentId = next.value
    }
    return { ok: true, value: steps }
  }

  const start = singleSuccessor(trigger)
  if (!start.ok) return start
  const walked = walkFrom(start.value)
  if (!walked.ok) return walked
  if (visited.size !== graph.nodes.length) {
    const orphans = graph.nodes.length - visited.size
    return fail(`${orphans} step${orphans === 1 ? ' is' : 's are'} not connected to the trigger`)
  }
  return { ok: true, value: { triggerId: trigger.id, steps: walked.value } }
}

/** Serialize the canvas tree back to graph JSON (deterministic DFS order). */
export function treeToGraph(tree: WorkflowTree): WorkflowGraphJson {
  const nodes: GraphNode[] = [{ id: tree.triggerId, type: 'trigger' }]
  const edges: GraphEdge[] = []

  const emit = (steps: TreeStep[], from: string, branchKey?: string): void => {
    let prev = from
    let label = branchKey
    for (const step of steps) {
      edges.push(
        label === undefined
          ? { from: prev, to: step.id }
          : { from: prev, to: step.id, branch: label }
      )
      label = undefined
      switch (step.kind) {
        case 'action':
          nodes.push({ id: step.id, type: 'action', action: step.action })
          break
        case 'condition':
          nodes.push({ id: step.id, type: 'condition', condition: step.condition })
          break
        case 'wait':
          nodes.push({ id: step.id, type: 'wait', seconds: step.seconds })
          break
        case 'branch':
          nodes.push({
            id: step.id,
            type: 'branch',
            branches: step.paths.map((p) => ({ key: p.key, condition: p.condition })),
          })
          for (const p of step.paths) emit(p.steps, step.id, p.key)
          break
      }
      prev = step.id
    }
  }

  emit(tree.steps, tree.triggerId)
  return { nodes, edges }
}

// ---------------------------------------------------------------------------
// Condition drafts: the one-level "all/any of these rules" shape the visual
// builder edits. Nested groups (or values that don't fit the field's kind)
// stay untouched as an "advanced" condition, still editable via JSON mode.
// ---------------------------------------------------------------------------

export interface ConditionRuleDraft {
  field: ConditionField
  op: ConditionOperator
  value: string
}

export interface SimpleConditionDraft {
  kind: 'simple'
  mode: 'all' | 'any'
  rules: ConditionRuleDraft[]
}

export type ConditionDraft = SimpleConditionDraft | { kind: 'advanced'; condition: GraphCondition }

type ConditionLeaf = Extract<GraphCondition, { field: string }>

function leafToRule(leaf: ConditionLeaf): ConditionRuleDraft | null {
  if (!isConditionField(leaf.field) || !isOperator(leaf.op)) return null
  const { field, op } = leaf
  if (VALUELESS_OPERATORS.has(op)) return { field, op, value: '' }
  const v = leaf.value
  switch (CONDITION_FIELD_META[field].kind) {
    case 'text':
    case 'choice':
      return typeof v === 'string' ? { field, op, value: v } : null
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? { field, op, value: String(v) } : null
    case 'boolean':
      return typeof v === 'boolean' ? { field, op, value: v ? 'true' : 'false' } : null
    case 'list':
      return Array.isArray(v) && v.every((x) => typeof x === 'string')
        ? { field, op, value: v.join(', ') }
        : null
  }
}

export function conditionToDraft(condition: GraphCondition): ConditionDraft {
  const advanced: ConditionDraft = { kind: 'advanced', condition }
  if ('field' in condition) {
    const rule = leafToRule(condition)
    return rule ? { kind: 'simple', mode: 'all', rules: [rule] } : advanced
  }
  const hasAll = condition.all !== undefined && condition.all.length > 0
  const hasAny = condition.any !== undefined && condition.any.length > 0
  if (hasAll && hasAny) return advanced
  if (!hasAll && !hasAny) return { kind: 'simple', mode: 'all', rules: [] }
  const rules: ConditionRuleDraft[] = []
  for (const child of (hasAll ? condition.all : condition.any)!) {
    if (!('field' in child)) return advanced
    const rule = leafToRule(child)
    if (!rule) return advanced
    rules.push(rule)
  }
  return { kind: 'simple', mode: hasAll ? 'all' : 'any', rules }
}

function ruleToLeaf(rule: ConditionRuleDraft): GraphCondition {
  if (VALUELESS_OPERATORS.has(rule.op)) return { field: rule.field, op: rule.op }
  let value: unknown
  switch (CONDITION_FIELD_META[rule.field].kind) {
    case 'number': {
      const n = Number(rule.value)
      value = Number.isFinite(n) ? n : 0
      break
    }
    case 'boolean':
      value = rule.value === 'true'
      break
    case 'list':
      value = rule.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      break
    default:
      value = rule.value
  }
  return { field: rule.field, op: rule.op, value }
}

export function draftToCondition(draft: SimpleConditionDraft): GraphCondition {
  if (draft.rules.length === 0) return {}
  const leaves = draft.rules.map(ruleToLeaf)
  if (leaves.length === 1) return leaves[0]!
  return draft.mode === 'all' ? { all: leaves } : { any: leaves }
}

export function defaultRule(): ConditionRuleDraft {
  return { field: 'conversation.status', op: 'eq', value: 'open' }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Entity id -> display name lookups for card summaries. */
export interface EntityLabels {
  members?: ReadonlyMap<string, string>
  teams?: ReadonlyMap<string, string>
  tags?: ReadonlyMap<string, string>
  slaPolicies?: ReadonlyMap<string, string>
}

const shortId = (id: string): string => (id.length > 14 ? `${id.slice(0, 14)}…` : id)

// Needs-setup placeholders summarize as "not chosen yet", not as a raw id.
const named = (id: string, lookup: ReadonlyMap<string, string> | undefined, missing: string) =>
  id && !isNeedsSetupRef(id) ? (lookup?.get(id) ?? shortId(id)) : missing

export function actionSummary(action: GraphAction, labels: EntityLabels = {}): string {
  switch (action.type) {
    case 'assign_agent':
      return `Assign to ${named(action.principalId, labels.members, 'a teammate…')}`
    case 'assign_team':
      return `Assign to ${named(action.teamId, labels.teams, 'a team…')}`
    case 'add_tag':
      return `Add tag ${named(action.tagId, labels.tags, '…')}`
    case 'remove_tag':
      return `Remove tag ${named(action.tagId, labels.tags, '…')}`
    case 'set_priority':
      return `Set priority to ${PRIORITY_LABELS[action.priority]}`
    case 'snooze':
      return action.untilIso
        ? `Snooze until ${new Date(action.untilIso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
        : 'Snooze until they reply'
    case 'close':
      return 'Close the conversation'
    case 'apply_sla':
      return `Apply SLA ${named(action.policyId, labels.slaPolicies, '…')}`
    case 'set_attribute':
      return action.key ? `Set ${action.key}` : 'Set an attribute…'
  }
}

function ruleSummary(rule: ConditionRuleDraft): string {
  const meta = CONDITION_FIELD_META[rule.field]
  const op = OPERATOR_LABELS[rule.op]
  if (VALUELESS_OPERATORS.has(rule.op)) return `${meta.label} ${op}`
  let value = rule.value
  if (meta.kind === 'choice') {
    value = meta.options?.find((o) => o.value === rule.value)?.label ?? rule.value
  } else if (meta.kind === 'boolean') {
    value = rule.value === 'true' ? 'yes' : 'no'
  }
  return `${meta.label} ${op} ${value || '…'}`
}

export function conditionSummary(condition: GraphCondition): string {
  const draft = conditionToDraft(condition)
  if (draft.kind === 'advanced') return 'Custom condition'
  if (draft.rules.length === 0) return 'Matches everything'
  const first = ruleSummary(draft.rules[0]!)
  if (draft.rules.length === 1) return first
  return `${first} +${draft.rules.length - 1} more`
}

export const WAIT_UNITS = [
  { value: 'seconds', seconds: 1, singular: 'second', plural: 'seconds' },
  { value: 'minutes', seconds: 60, singular: 'minute', plural: 'minutes' },
  { value: 'hours', seconds: 3600, singular: 'hour', plural: 'hours' },
  { value: 'days', seconds: 86400, singular: 'day', plural: 'days' },
] as const

export type WaitUnit = (typeof WAIT_UNITS)[number]['value']

/** The largest unit that divides the wait evenly (falls back to seconds). */
export function secondsToWaitParts(total: number): { amount: number; unit: WaitUnit } {
  for (let i = WAIT_UNITS.length - 1; i >= 0; i--) {
    const unit = WAIT_UNITS[i]!
    if (total > 0 && total % unit.seconds === 0) {
      return { amount: total / unit.seconds, unit: unit.value }
    }
  }
  return { amount: total, unit: 'minutes' }
}

export function waitSummary(totalSeconds: number): string {
  const { amount, unit } = secondsToWaitParts(totalSeconds)
  const meta = WAIT_UNITS.find((u) => u.value === unit)!
  return `Wait ${amount} ${amount === 1 ? meta.singular : meta.plural}`
}

/** set_attribute values keep JSON types: "5" stays a number, "vip" a string. */
export function parseAttributeValue(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function attributeValueText(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? ''
}

// ---------------------------------------------------------------------------
// The editor draft: visual (tree) or JSON text, switchable both ways.
// ---------------------------------------------------------------------------

export type GraphDraft =
  | { mode: 'visual'; tree: WorkflowTree }
  | { mode: 'json'; text: string; notice?: string }

/**
 * Open a stored graph for editing: visual when the graph is tree-shaped,
 * otherwise JSON mode with the reason (nothing is dropped or rewritten).
 */
export function initialGraphDraft(graph: unknown): GraphDraft {
  if (graph == null) return { mode: 'visual', tree: newTree() }
  const asText = () => JSON.stringify(graph, null, 2) ?? ''
  const valid = validateGraph(graph)
  if (!valid.ok) {
    return {
      mode: 'json',
      text: asText(),
      notice: `The stored graph needs attention: ${valid.error}`,
    }
  }
  const tree = graphToTree(valid.value)
  if (!tree.ok) {
    return {
      mode: 'json',
      text: asText(),
      notice: `Shown as JSON because ${tree.error}. The visual builder needs a single tree of paths.`,
    }
  }
  return { mode: 'visual', tree: tree.value }
}

/** The graph JSON to save, from whichever mode the editor is in. */
export function draftToGraphJson(draft: GraphDraft): Result<WorkflowGraphJson> {
  if (draft.mode === 'json') return parseWorkflowGraphText(draft.text)
  // Re-validate so half-filled steps (e.g. an assign with no teammate) fail
  // here with a readable message instead of a server 400.
  const graph = treeToGraph(draft.tree)
  const check = validateGraph(graph)
  return check.ok ? { ok: true, value: graph } : check
}

// ---------------------------------------------------------------------------
// Step addressing: locate/replace a step by id without threading positional
// callbacks through the render recursion. The fullscreen builder's inspector
// panel is not co-located with the node it edits (the canvas only renders
// cards and reports a selected id), so it needs to turn "step X changed" into
// an updated tree knowing only X's id.
// ---------------------------------------------------------------------------

/** One branch hop (which branch step, which of its paths) from the tree root. */
export interface StepLocation {
  path: { branchId: string; pathKey: string }[]
}

export const ROOT_LOCATION: StepLocation = { path: [] }

/** The steps array a location addresses (the root list, or a branch path's). */
export function stepsAtLocation(tree: WorkflowTree, location: StepLocation): TreeStep[] {
  let steps = tree.steps
  for (const hop of location.path) {
    const branch = steps.find((s) => s.id === hop.branchId)
    if (!branch || branch.kind !== 'branch') return []
    const path = branch.paths.find((p) => p.key === hop.pathKey)
    steps = path ? path.steps : []
  }
  return steps
}

function replaceStepsAtLocation(
  tree: WorkflowTree,
  location: StepLocation,
  steps: TreeStep[]
): WorkflowTree {
  if (location.path.length === 0) return { ...tree, steps }
  const replaceIn = (current: TreeStep[], hops: StepLocation['path']): TreeStep[] => {
    const [hop, ...rest] = hops
    return current.map((s) => {
      if (!hop || s.id !== hop.branchId || s.kind !== 'branch') return s
      return {
        ...s,
        paths: s.paths.map((p) =>
          p.key !== hop.pathKey
            ? p
            : { ...p, steps: rest.length === 0 ? steps : replaceIn(p.steps, rest) }
        ),
      }
    })
  }
  return { ...tree, steps: replaceIn(tree.steps, location.path) }
}

/** Find a step anywhere in the tree by id, with the location needed to update it. */
export function findStepById(
  tree: WorkflowTree,
  id: string
): { step: TreeStep; location: StepLocation } | null {
  const search = (
    steps: TreeStep[],
    location: StepLocation
  ): { step: TreeStep; location: StepLocation } | null => {
    for (const step of steps) {
      if (step.id === id) return { step, location }
      if (step.kind === 'branch') {
        for (const p of step.paths) {
          const found = search(p.steps, {
            path: [...location.path, { branchId: step.id, pathKey: p.key }],
          })
          if (found) return found
        }
      }
    }
    return null
  }
  return search(tree.steps, ROOT_LOCATION)
}

/** Insert `step` at `index` within the steps array `location` addresses. */
export function insertStepAt(
  tree: WorkflowTree,
  location: StepLocation,
  index: number,
  step: TreeStep
): WorkflowTree {
  return replaceStepsAtLocation(
    tree,
    location,
    insertStep(stepsAtLocation(tree, location), index, step)
  )
}

/** Replace the step with `id` (wherever it is) via `updater`. A no-op if missing. */
export function updateStepById(
  tree: WorkflowTree,
  id: string,
  updater: (step: TreeStep) => TreeStep
): WorkflowTree {
  const found = findStepById(tree, id)
  if (!found) return tree
  const steps = stepsAtLocation(tree, found.location)
  return replaceStepsAtLocation(
    tree,
    found.location,
    steps.map((s) => (s.id === id ? updater(s) : s))
  )
}

/** Remove the step with `id` (wherever it is), along with any nested steps. */
export function removeStepById(tree: WorkflowTree, id: string): WorkflowTree {
  const found = findStepById(tree, id)
  if (!found) return tree
  const steps = stepsAtLocation(tree, found.location)
  return replaceStepsAtLocation(
    tree,
    found.location,
    steps.filter((s) => s.id !== id)
  )
}

// ---------------------------------------------------------------------------
// Per-step issues: the subset of validateAction's rules that apply to an
// already-typed GraphAction. Every step in a WorkflowTree is well-formed (it
// came from a validated graph or from createStep's defaults), so the only
// thing left to flag is a step still missing a required choice — e.g. an
// "Assign to team" step with no team picked yet. Kept in sync with
// validateAction by hand: that one validates unknown JSON and prefixes a
// "where", this one validates a typed action for a plain message, so they
// can't share one function body.
// ---------------------------------------------------------------------------

/** Sentinel ref prefix used by workflow templates for config only the workspace
 *  can supply (a team id, an SLA policy id). Sentinels keep template graphs
 *  schema-valid so they create cleanly, while reading as unset here so the list
 *  badge and the builder's issues chip demand setup before going live. */
export const NEEDS_SETUP_PREFIX = 'needs-setup-'

/** True when the ref is a template placeholder rather than a real id. */
export function isNeedsSetupRef(v: string | undefined): boolean {
  return typeof v === 'string' && v.startsWith(NEEDS_SETUP_PREFIX)
}

const isSetRef = (v: string | undefined): boolean => Boolean(v) && !isNeedsSetupRef(v)

export function actionIssue(action: GraphAction): string | null {
  switch (action.type) {
    case 'assign_agent':
      return isSetRef(action.principalId) ? null : 'Choose a teammate to assign'
    case 'assign_team':
      return isSetRef(action.teamId) ? null : 'Choose a team to assign'
    case 'add_tag':
      return isSetRef(action.tagId) ? null : 'Choose a tag to add'
    case 'remove_tag':
      return isSetRef(action.tagId) ? null : 'Choose a tag to remove'
    case 'apply_sla':
      return isSetRef(action.policyId) ? null : 'Choose an SLA policy'
    case 'set_attribute':
      return action.key ? null : 'Choose an attribute'
    case 'set_priority':
    case 'snooze':
    case 'close':
      return null
  }
}

/** Every step id in the tree with an unresolved issue, mapped to its message. */
export function collectStepIssues(tree: WorkflowTree): Map<string, string> {
  const issues = new Map<string, string>()
  const walk = (steps: TreeStep[]) => {
    for (const step of steps) {
      if (step.kind === 'action') {
        const message = actionIssue(step.action)
        if (message) issues.set(step.id, message)
      } else if (step.kind === 'branch') {
        for (const p of step.paths) walk(p.steps)
      }
    }
  }
  walk(tree.steps)
  return issues
}

export interface DraftIssues {
  count: number
  ids: ReadonlySet<string>
  firstId: string | null
  /** A structural problem (bad JSON, a cycle, an orphan step) blocking save entirely. */
  blocking: string | null
}

/** Validation summary for the top bar's issues chip and the Set-live gate. */
export function draftIssues(draft: GraphDraft): DraftIssues {
  if (draft.mode === 'json') {
    const parsed = parseWorkflowGraphText(draft.text)
    if (!parsed.ok) return { count: 1, ids: new Set(), firstId: null, blocking: parsed.error }
    return { count: 0, ids: new Set(), firstId: null, blocking: null }
  }
  const stepIssues = collectStepIssues(draft.tree)
  const ids = new Set(stepIssues.keys())
  const [firstId = null] = ids
  return { count: ids.size, ids, firstId, blocking: null }
}

// ---------------------------------------------------------------------------
// Outline: a flat top-to-bottom list for the builder's left rail, derived from
// the same tree the canvas renders. Branch paths get an unselectable section
// header row ("Path A · Billing"); everything else is one selectable row per
// step, indented one level per branch nesting.
// ---------------------------------------------------------------------------

export type OutlineEntry =
  | { kind: 'trigger'; id: string; label: string; depth: number; hasIssue: false }
  | { kind: TreeStep['kind']; id: string; label: string; depth: number; hasIssue: boolean }
  | { kind: 'path-header'; label: string; depth: number }

export const PATH_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function stepLabel(step: TreeStep, labels: EntityLabels): string {
  switch (step.kind) {
    case 'action':
      return actionSummary(step.action, labels)
    case 'condition':
      return conditionSummary(step.condition)
    case 'wait':
      return waitSummary(step.seconds)
    case 'branch':
      return `Branch · ${step.paths.length} path${step.paths.length === 1 ? '' : 's'}`
  }
}

export function deriveOutline(
  tree: WorkflowTree,
  triggerLabelText: string,
  issues: ReadonlyMap<string, string>,
  labels: EntityLabels = {}
): OutlineEntry[] {
  const entries: OutlineEntry[] = [
    { kind: 'trigger', id: tree.triggerId, label: triggerLabelText, depth: 0, hasIssue: false },
  ]
  const walk = (steps: TreeStep[], depth: number) => {
    for (const step of steps) {
      entries.push({
        kind: step.kind,
        id: step.id,
        label: stepLabel(step, labels),
        depth,
        hasIssue: issues.has(step.id),
      })
      if (step.kind === 'branch') {
        step.paths.forEach((p, i) => {
          const letter = PATH_LETTERS[i] ?? String(i + 1)
          entries.push({
            kind: 'path-header',
            label: `Path ${letter} · ${p.key}`,
            depth: depth + 1,
          })
          walk(p.steps, depth + 1)
        })
      }
    }
  }
  walk(tree.steps, 0)
  return entries
}
