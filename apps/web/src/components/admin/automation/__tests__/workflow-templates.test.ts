/**
 * Every workflow template must produce a structurally valid graph (the same
 * schema the server re-validates on save) and a trigger type the workflows
 * manager actually knows how to group and label.
 */
import { describe, it, expect } from 'vitest'
import { workflowGraphSchema } from '@/lib/server/domains/workflows/workflow.schemas'
import { collectStepIssues, graphToTree, NEEDS_SETUP_PREFIX } from '../workflow-graph'
import { WORKFLOW_TEMPLATES, workflowTemplatesByCategory } from '../workflow-templates'

const KNOWN_TRIGGERS = [
  'conversation.created',
  'message.created',
  'conversation.status_changed',
  'conversation.assigned',
  'assistant.handed_off',
]

describe('WORKFLOW_TEMPLATES', () => {
  it.each(WORKFLOW_TEMPLATES)('$id has a graph that passes workflowGraphSchema', (template) => {
    const result = workflowGraphSchema.safeParse(template.payload.graph)
    expect(result.success, result.success ? undefined : JSON.stringify(result.error?.issues)).toBe(
      true
    )
  })

  it.each(WORKFLOW_TEMPLATES)('$id uses a known trigger type', (template) => {
    expect(KNOWN_TRIGGERS).toContain(template.payload.triggerType)
  })

  it('has between 4 and 8 templates', () => {
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThanOrEqual(4)
    expect(WORKFLOW_TEMPLATES.length).toBeLessThanOrEqual(8)
  })

  it('gives every template a unique id', () => {
    const ids = WORKFLOW_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('places every template in at least one category', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      expect(template.categories.length).toBeGreaterThan(0)
    }
  })

  it('filters templates by category', () => {
    const popular = workflowTemplatesByCategory('popular')
    expect(popular.length).toBeGreaterThan(0)
    for (const template of popular) {
      expect(template.categories).toContain('popular')
    }
  })

  // Templates can't ship real team/policy ids, so they use needs-setup
  // placeholders. Those must read as unresolved step issues — that's what
  // drives the list's "Needs setup" badge and the builder's issues chip.
  it('flags needs-setup placeholder refs as step issues', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const graphJson = JSON.stringify(template.payload.graph)
      if (!graphJson.includes(NEEDS_SETUP_PREFIX)) continue
      const tree = graphToTree(template.payload.graph)
      expect(tree.ok).toBe(true)
      if (tree.ok) {
        expect(
          collectStepIssues(tree.value).size,
          `${template.id} should need setup`
        ).toBeGreaterThan(0)
      }
    }
  })

  it('has at least one template that ships needing setup', () => {
    const withPlaceholders = WORKFLOW_TEMPLATES.filter((t) =>
      JSON.stringify(t.payload.graph).includes(NEEDS_SETUP_PREFIX)
    )
    expect(withPlaceholders.length).toBeGreaterThan(0)
  })

  // AI-ATTRIBUTES-PARITY-SPEC.md Phase 2 routing templates: option ids are
  // minted per-workspace at random (packages/db/drizzle/0178_ai_attribute_detection.sql),
  // so a branch/condition that decides on one can only ship unset -- an `eq`
  // leaf with an empty value, the degraded placeholder the builder already
  // renders as unresolved (ruleSummary's `value || '…'` fallback). These
  // assertions pin that shape so a future template author doesn't
  // accidentally hardcode an option id that will never exist in a real
  // workspace.
  describe('AI attribute routing templates', () => {
    function leaves(condition: unknown): { field: string; op: string; value?: unknown }[] {
      if (!condition || typeof condition !== 'object') return []
      if ('field' in condition) return [condition as { field: string; op: string; value?: unknown }]
      const group = condition as { all?: unknown[]; any?: unknown[] }
      return [...(group.all ?? []), ...(group.any ?? [])].flatMap((c) => leaves(c))
    }

    function allConditions(template: (typeof WORKFLOW_TEMPLATES)[number]): unknown[] {
      const conditions: unknown[] = []
      for (const node of template.payload.graph.nodes) {
        if (node.type === 'condition') conditions.push(node.condition)
        if (node.type === 'branch') conditions.push(...node.branches.map((b) => b.condition))
      }
      return conditions
    }

    it('route-by-issue-type branches on conversation.attr.issue_type with unset eq placeholders', () => {
      const template = WORKFLOW_TEMPLATES.find((t) => t.id === 'route-by-issue-type')
      expect(template).toBeDefined()
      const attrLeaves = allConditions(template!)
        .flatMap((c) => leaves(c))
        .filter((l) => l.field === 'conversation.attr.issue_type')
      expect(attrLeaves.length).toBeGreaterThanOrEqual(2)
      for (const leaf of attrLeaves) {
        expect(leaf.op).toBe('eq')
        expect(leaf.value).toBe('')
      }
      expect(template!.payload.triggerType).toBe('assistant.handed_off')
      expect(template!.benefit.toLowerCase()).toContain('ai attribute detection')
    })

    it('escalate-frustrated-customers gates on conversation.attr.sentiment with an unset eq placeholder', () => {
      const template = WORKFLOW_TEMPLATES.find((t) => t.id === 'escalate-frustrated-customers')
      expect(template).toBeDefined()
      const attrLeaves = allConditions(template!)
        .flatMap((c) => leaves(c))
        .filter((l) => l.field === 'conversation.attr.sentiment')
      expect(attrLeaves).toEqual([{ field: 'conversation.attr.sentiment', op: 'eq', value: '' }])
      expect(template!.payload.triggerType).toBe('assistant.handed_off')
      expect(template!.benefit.toLowerCase()).toContain('ai attribute detection')
    })
  })
})
