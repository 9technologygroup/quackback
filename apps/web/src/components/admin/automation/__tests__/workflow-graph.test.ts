/**
 * The workflow canvas model: graph <-> tree round-trips (the canvas must be a
 * lossless view over the graph JSON), tree-representability failures, client
 * validation parity with the server schema, and the condition draft mapping.
 */
import { describe, expect, it } from 'vitest'
import { workflowGraphSchema } from '@/lib/server/domains/workflows/workflow.schemas'
import {
  conditionToDraft,
  createStep,
  draftToCondition,
  draftToGraphJson,
  freshStepId,
  graphToTree,
  initialGraphDraft,
  insertStep,
  newTree,
  treeToGraph,
  validateGraph,
  type GraphCondition,
  type TreeStep,
  type WorkflowGraphJson,
  type WorkflowTree,
} from '../workflow-graph'

/** A canvas-shaped graph in canonical DFS order: trigger -> condition ->
 *  action -> branch with two labeled paths (one nested wait + action). */
const richGraph: WorkflowGraphJson = {
  nodes: [
    { id: 'trigger', type: 'trigger' },
    {
      id: 'condition-1',
      type: 'condition',
      condition: { all: [{ field: 'conversation.channel', op: 'eq', value: 'email' }] },
    },
    { id: 'action-1', type: 'action', action: { type: 'add_tag', tagId: 'tag_inbound' } },
    {
      id: 'branch-1',
      type: 'branch',
      branches: [
        {
          key: 'VIP',
          condition: { field: 'person.segments', op: 'includes_any', value: ['seg_vip'] },
        },
        { key: 'Everyone else', condition: {} },
      ],
    },
    { id: 'wait-1', type: 'wait', seconds: 3600 },
    { id: 'action-2', type: 'action', action: { type: 'set_priority', priority: 'urgent' } },
    { id: 'action-3', type: 'action', action: { type: 'close' } },
  ],
  edges: [
    { from: 'trigger', to: 'condition-1' },
    { from: 'condition-1', to: 'action-1' },
    { from: 'action-1', to: 'branch-1' },
    { from: 'branch-1', to: 'wait-1', branch: 'VIP' },
    { from: 'wait-1', to: 'action-2' },
    { from: 'branch-1', to: 'action-3', branch: 'Everyone else' },
  ],
}

describe('graph <-> tree round-trip', () => {
  it('round-trips a canvas-shaped graph byte-identically', () => {
    const tree = graphToTree(richGraph)
    expect(tree.ok).toBe(true)
    if (!tree.ok) return
    expect(treeToGraph(tree.value)).toEqual(richGraph)
  })

  it('keeps ids and branch keys stable across repeated round-trips', () => {
    const once = graphToTree(richGraph)
    if (!once.ok) throw new Error(once.error)
    const twice = graphToTree(treeToGraph(once.value))
    if (!twice.ok) throw new Error(twice.error)
    expect(treeToGraph(twice.value)).toEqual(richGraph)
  })

  it('serializes an empty tree to a lone trigger node', () => {
    expect(treeToGraph(newTree())).toEqual({
      nodes: [{ id: 'trigger', type: 'trigger' }],
      edges: [],
    })
  })
})

describe('server schema parity', () => {
  it('every canvas-produced graph passes workflowGraphSchema', () => {
    const tree = newTree()
    const steps: TreeStep[] = [
      { id: 'action-1', kind: 'action', action: { type: 'assign_agent', principalId: 'p_1' } },
      { id: 'action-2', kind: 'action', action: { type: 'assign_team', teamId: 't_1' } },
      { id: 'action-3', kind: 'action', action: { type: 'remove_tag', tagId: 'tag_1' } },
      { id: 'action-4', kind: 'action', action: { type: 'snooze', untilIso: null } },
      {
        id: 'action-5',
        kind: 'action',
        action: { type: 'snooze', untilIso: '2026-08-01T09:00:00.000Z' },
      },
      { id: 'action-6', kind: 'action', action: { type: 'apply_sla', policyId: 'sla_1' } },
      { id: 'action-7', kind: 'action', action: { type: 'set_attribute', key: 'plan', value: 5 } },
      { id: 'wait-1', kind: 'wait', seconds: 0 },
      {
        id: 'condition-1',
        kind: 'condition',
        condition: { any: [{ field: 'csat.rating', op: 'lte', value: 2 }] },
      },
      {
        id: 'branch-1',
        kind: 'branch',
        paths: [
          {
            key: 'Office hours',
            condition: { field: 'office_hours', op: 'eq', value: true },
            steps: [
              {
                id: 'action-8',
                kind: 'action',
                action: { type: 'set_priority', priority: 'high' },
              },
            ],
          },
          { key: 'After hours', condition: {}, steps: [] },
        ],
      },
    ]
    const graph = treeToGraph({ ...tree, steps })
    const parsed = workflowGraphSchema.safeParse(graph)
    expect(parsed.success).toBe(true)
    // And the client-side validator agrees.
    expect(validateGraph(graph).ok).toBe(true)
  })

  it('rejects the same incomplete steps the server would, with readable errors', () => {
    const missingAgent = treeToGraph({
      triggerId: 'trigger',
      steps: [
        { id: 'action-1', kind: 'action', action: { type: 'assign_agent', principalId: '' } },
      ],
    })
    expect(workflowGraphSchema.safeParse(missingAgent).success).toBe(false)
    const check = validateGraph(missingAgent)
    expect(check).toEqual({ ok: false, error: 'Step "action-1": choose a teammate to assign' })
  })
})

describe('validateGraph', () => {
  const withNode = (node: unknown): unknown => ({
    nodes: [{ id: 'trigger', type: 'trigger' }, node],
    edges: [],
  })

  it.each([
    ['unknown node type', withNode({ id: 'x', type: 'watt' }), /unknown step type/],
    [
      'unknown condition field',
      withNode({
        id: 'x',
        type: 'condition',
        condition: { field: 'conversation.stattus', op: 'eq' },
      }),
      /unknown condition field/,
    ],
    [
      'unknown operator',
      withNode({
        id: 'x',
        type: 'condition',
        condition: { field: 'conversation.status', op: 'equals' },
      }),
      /unknown operator/,
    ],
    [
      'stray group key',
      withNode({ id: 'x', type: 'condition', condition: { some: [] } }),
      /unexpected key/,
    ],
    ['negative wait', withNode({ id: 'x', type: 'wait', seconds: -5 }), /whole number of seconds/],
    [
      'non-UTC snooze timestamp',
      withNode({
        id: 'x',
        type: 'action',
        action: { type: 'snooze', untilIso: '2026-08-01 09:00' },
      }),
      /UTC timestamp/,
    ],
    ['nodes not an array', { nodes: {}, edges: [] }, /"nodes" must be an array/],
    [
      'edge missing endpoints',
      { nodes: [{ id: 'trigger', type: 'trigger' }], edges: [{ from: 'trigger' }] },
      /"from" and "to"/,
    ],
  ])('rejects %s', (_name, graph, message) => {
    const result = validateGraph(graph)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(message)
  })
})

describe('graphToTree representability', () => {
  const trigger = { id: 'trigger', type: 'trigger' } as const
  const action = (id: string) =>
    ({ id, type: 'action', action: { type: 'close' } }) as WorkflowGraphJson['nodes'][number]

  it.each([
    [
      'two triggers',
      { nodes: [trigger, { id: 't2', type: 'trigger' }], edges: [] },
      /more than one trigger/,
    ],
    ['no trigger', { nodes: [action('a')], edges: [] }, /no trigger/],
    [
      'unreachable step',
      { nodes: [trigger, action('a')], edges: [] },
      /needs exactly one incoming connection/,
    ],
    [
      'merge (two parents)',
      {
        nodes: [trigger, action('a'), action('b'), action('c')],
        edges: [
          { from: 'trigger', to: 'a' },
          { from: 'a', to: 'c' },
          { from: 'b', to: 'c' },
        ],
      },
      /incoming connection/,
    ],
    [
      'labeled edge from a non-branch step',
      {
        nodes: [trigger, action('a'), action('b')],
        edges: [
          { from: 'trigger', to: 'a' },
          { from: 'a', to: 'b', branch: 'oops' },
        ],
      },
      /labeled connection but is not a branch/,
    ],
    [
      'duplicate node ids',
      { nodes: [trigger, action('a'), action('a')], edges: [{ from: 'trigger', to: 'a' }] },
      /share the id/,
    ],
  ])('falls back to JSON for %s', (_name, graph, message) => {
    const result = graphToTree(graph as WorkflowGraphJson)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(message)
  })

  it('initialGraphDraft opens those graphs in JSON mode with a notice', () => {
    const graph = { nodes: [trigger, action('a')], edges: [] }
    const draft = initialGraphDraft(graph)
    expect(draft.mode).toBe('json')
    if (draft.mode === 'json') {
      expect(draft.notice).toMatch(/Shown as JSON/)
      expect(JSON.parse(draft.text)).toEqual(graph)
    }
  })

  it('initialGraphDraft opens tree-shaped and missing graphs on the canvas', () => {
    expect(initialGraphDraft(undefined)).toEqual({ mode: 'visual', tree: newTree() })
    const draft = initialGraphDraft(richGraph)
    expect(draft.mode).toBe('visual')
  })
})

describe('condition drafts', () => {
  it('maps a leaf to one rule and back to a leaf', () => {
    const leaf = { field: 'message.body', op: 'contains', value: 'refund' } as const
    const draft = conditionToDraft(leaf)
    expect(draft).toEqual({
      kind: 'simple',
      mode: 'all',
      rules: [{ field: 'message.body', op: 'contains', value: 'refund' }],
    })
    if (draft.kind === 'simple') expect(draftToCondition(draft)).toEqual(leaf)
  })

  it('round-trips any-groups and typed values (number, boolean, list)', () => {
    const group: GraphCondition = {
      any: [
        { field: 'csat.rating', op: 'lte', value: 2 },
        { field: 'office_hours', op: 'eq', value: false },
        { field: 'conversation.tags', op: 'includes_any', value: ['tag_a', 'tag_b'] },
      ],
    }
    const draft = conditionToDraft(group)
    expect(draft.kind).toBe('simple')
    if (draft.kind !== 'simple') return
    expect(draft.mode).toBe('any')
    expect(draft.rules[0]?.value).toBe('2')
    expect(draft.rules[1]?.value).toBe('false')
    expect(draft.rules[2]?.value).toBe('tag_a, tag_b')
    expect(draftToCondition(draft)).toEqual(group)
  })

  it('treats an empty group as "matches everything"', () => {
    const draft = conditionToDraft({})
    expect(draft).toEqual({ kind: 'simple', mode: 'all', rules: [] })
    if (draft.kind === 'simple') expect(draftToCondition(draft)).toEqual({})
  })

  it('preserves nested groups untouched as advanced', () => {
    const nested: GraphCondition = {
      all: [{ any: [{ field: 'conversation.status', op: 'eq', value: 'open' }] }],
    }
    const draft = conditionToDraft(nested)
    expect(draft).toEqual({ kind: 'advanced', condition: nested })
  })
})

describe('tree editing helpers', () => {
  it('inserting a branch mid-path moves the tail into its first path', () => {
    const tree: WorkflowTree = {
      triggerId: 'trigger',
      steps: [
        { id: 'action-1', kind: 'action', action: { type: 'close' } },
        { id: 'wait-1', kind: 'wait', seconds: 60 },
      ],
    }
    const branch = createStep(tree, 'branch')
    const steps = insertStep(tree.steps, 1, branch)
    expect(steps.map((s) => s.kind)).toEqual(['action', 'branch'])
    const inserted = steps[1]
    if (inserted?.kind !== 'branch') throw new Error('expected a branch')
    expect(inserted.paths[0]?.steps.map((s) => s.id)).toEqual(['wait-1'])
    // The invariant holds, so the serialized graph is still tree-shaped.
    const graph = treeToGraph({ ...tree, steps })
    expect(graphToTree(graph).ok).toBe(true)
  })

  it('freshStepId skips ids already used anywhere in the tree', () => {
    const tree: WorkflowTree = {
      triggerId: 'trigger',
      steps: [
        {
          id: 'branch-1',
          kind: 'branch',
          paths: [
            {
              key: 'A',
              condition: {},
              steps: [{ id: 'action-1', kind: 'action', action: { type: 'close' } }],
            },
          ],
        },
      ],
    }
    expect(freshStepId(tree, 'action')).toBe('action-2')
    expect(freshStepId(tree, 'branch')).toBe('branch-2')
    expect(freshStepId(tree, 'wait')).toBe('wait-1')
  })

  it('draftToGraphJson validates the JSON escape hatch', () => {
    const bad = draftToGraphJson({ mode: 'json', text: '{ nope' })
    expect(bad.ok).toBe(false)
    const good = draftToGraphJson({ mode: 'json', text: JSON.stringify(richGraph) })
    expect(good).toEqual({ ok: true, value: richGraph })
  })
})
