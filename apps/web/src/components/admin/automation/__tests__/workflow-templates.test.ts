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

  it('has between 4 and 6 templates', () => {
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThanOrEqual(4)
    expect(WORKFLOW_TEMPLATES.length).toBeLessThanOrEqual(6)
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
})
