/**
 * Starter templates for the workflow gallery (support platform §4.6). Each
 * template is a ready-to-create workflow: the payload shape matches
 * `createWorkflowFn`'s input exactly, so the gallery just forwards it to
 * `useCreateWorkflow`. Graphs are hand-built against the node/edge shapes in
 * `workflow-graph.ts` and must stay valid against `workflowGraphSchema` (see
 * `__tests__/workflow-templates.test.ts`).
 *
 * Some templates reference a team, SLA policy, or tag that only exists in a
 * real workspace. Those fields can't be left blank -- the schema requires a
 * non-empty id -- so they ship with an obvious placeholder id (e.g.
 * "needs-setup-team") instead of a real one. The created workflow stays a
 * draft until someone opens it in the builder and points the step at a real
 * team, policy, or tag.
 */
import type { ComponentType, SVGProps } from 'react'
import {
  ArrowsRightLeftIcon,
  ClockIcon,
  ShieldCheckIcon,
  TagIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline'
import { NEEDS_SETUP_PREFIX, type WorkflowGraphJson } from './workflow-graph'

export type WorkflowTemplateCategory = 'popular' | 'routing' | 'sla' | 'housekeeping'

export const WORKFLOW_TEMPLATE_CATEGORIES: {
  key: WorkflowTemplateCategory
  label: string
}[] = [
  { key: 'popular', label: 'Popular' },
  { key: 'routing', label: 'Routing' },
  { key: 'sla', label: 'SLA & priority' },
  { key: 'housekeeping', label: 'Housekeeping' },
]

export interface WorkflowTemplatePayload {
  name: string
  class: 'customer_facing' | 'background'
  triggerType: string
  triggerSettings?: Record<string, unknown>
  graph: WorkflowGraphJson
}

export interface WorkflowTemplate {
  id: string
  title: string
  /** One-line benefit shown as a small pill on the card. */
  benefit: string
  categories: WorkflowTemplateCategory[]
  icon: ComponentType<SVGProps<SVGSVGElement>>
  iconClassName: string
  /** Short "step 1 · step 2" footer summarizing the graph. */
  stepsSummary: string
  payload: WorkflowTemplatePayload
}

/** Placeholder ids for fields that need a real workspace value before the
 *  workflow can go live. Built on NEEDS_SETUP_PREFIX so `actionIssue` reads
 *  them as unset and the list/builder surface a "Needs setup" issue. */
const NEEDS_SETUP_TEAM = `${NEEDS_SETUP_PREFIX}team`
const NEEDS_SETUP_POLICY = `${NEEDS_SETUP_PREFIX}sla-policy`

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'route-to-team',
    title: 'Route conversations to the right team',
    benefit: 'Speed up support',
    categories: ['popular', 'routing'],
    icon: ArrowsRightLeftIcon,
    iconClassName: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    stepsSummary: 'Branch on message body · Assign to team',
    payload: {
      name: 'Route conversations to the right team',
      class: 'customer_facing',
      triggerType: 'conversation.created',
      graph: {
        nodes: [
          { id: 'trigger', type: 'trigger' },
          {
            id: 'branch_topic',
            type: 'branch',
            branches: [
              {
                key: 'billing',
                condition: { field: 'message.body', op: 'contains', value: 'billing' },
              },
              { key: 'everything_else', condition: {} },
            ],
          },
          {
            id: 'assign_billing',
            type: 'action',
            action: { type: 'assign_team', teamId: NEEDS_SETUP_TEAM },
          },
          {
            id: 'assign_support',
            type: 'action',
            action: { type: 'assign_team', teamId: NEEDS_SETUP_TEAM },
          },
        ],
        edges: [
          { from: 'trigger', to: 'branch_topic' },
          { from: 'branch_topic', to: 'assign_billing', branch: 'billing' },
          { from: 'branch_topic', to: 'assign_support', branch: 'everything_else' },
        ],
      },
    },
  },
  {
    id: 'sla-by-priority',
    title: 'Apply SLAs by priority',
    benefit: 'Never miss a target',
    categories: ['popular', 'sla'],
    icon: ShieldCheckIcon,
    iconClassName: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    stepsSummary: 'Branch on priority · Apply SLA policy',
    payload: {
      name: 'Apply SLAs by priority',
      class: 'customer_facing',
      triggerType: 'conversation.created',
      graph: {
        nodes: [
          { id: 'trigger', type: 'trigger' },
          {
            id: 'branch_priority',
            type: 'branch',
            branches: [
              {
                key: 'high_priority',
                condition: { field: 'conversation.priority', op: 'eq', value: 'high' },
              },
              { key: 'everything_else', condition: {} },
            ],
          },
          {
            id: 'apply_priority_sla',
            type: 'action',
            action: { type: 'apply_sla', policyId: NEEDS_SETUP_POLICY },
          },
          {
            id: 'apply_standard_sla',
            type: 'action',
            action: { type: 'apply_sla', policyId: NEEDS_SETUP_POLICY },
          },
        ],
        edges: [
          { from: 'trigger', to: 'branch_priority' },
          { from: 'branch_priority', to: 'apply_priority_sla', branch: 'high_priority' },
          { from: 'branch_priority', to: 'apply_standard_sla', branch: 'everything_else' },
        ],
      },
    },
  },
  {
    id: 'escalate-long-waits',
    title: 'Escalate long waits',
    benefit: 'Catch slow replies',
    categories: ['sla'],
    icon: ClockIcon,
    iconClassName: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
    stepsSummary: 'Wait 30m · Check waiting time · Set priority · Assign to team',
    payload: {
      name: 'Escalate long waits',
      class: 'background',
      triggerType: 'conversation.created',
      graph: {
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'wait_30m', type: 'wait', seconds: 1800 },
          {
            id: 'still_waiting',
            type: 'condition',
            condition: { field: 'conversation.waiting_minutes', op: 'gte', value: 30 },
          },
          {
            id: 'set_priority_high',
            type: 'action',
            action: { type: 'set_priority', priority: 'high' },
          },
          {
            id: 'assign_escalation_team',
            type: 'action',
            action: { type: 'assign_team', teamId: NEEDS_SETUP_TEAM },
          },
        ],
        edges: [
          { from: 'trigger', to: 'wait_30m' },
          { from: 'wait_30m', to: 'still_waiting' },
          { from: 'still_waiting', to: 'set_priority_high' },
          { from: 'set_priority_high', to: 'assign_escalation_team' },
        ],
      },
    },
  },
  {
    id: 'auto-close-idle',
    title: 'Auto-close idle conversations',
    benefit: 'Keep the inbox clean',
    categories: ['housekeeping'],
    icon: XCircleIcon,
    iconClassName: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
    stepsSummary: 'Wait 3 days · Close conversation',
    payload: {
      name: 'Auto-close idle conversations',
      class: 'background',
      triggerType: 'conversation.created',
      graph: {
        nodes: [
          { id: 'trigger', type: 'trigger' },
          { id: 'wait_3_days', type: 'wait', seconds: 259_200 },
          { id: 'close_conversation', type: 'action', action: { type: 'close' } },
        ],
        edges: [
          { from: 'trigger', to: 'wait_3_days' },
          { from: 'wait_3_days', to: 'close_conversation' },
        ],
      },
    },
  },
  {
    id: 'tag-billing-keywords',
    title: 'Tag billing keywords',
    benefit: 'Organize automatically',
    categories: ['routing', 'housekeeping'],
    icon: TagIcon,
    iconClassName: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
    stepsSummary: 'Condition · Add tag',
    payload: {
      name: 'Tag billing keywords',
      class: 'background',
      triggerType: 'message.created',
      graph: {
        nodes: [
          { id: 'trigger', type: 'trigger' },
          {
            id: 'mentions_billing',
            type: 'condition',
            condition: { field: 'message.body', op: 'contains', value: 'billing' },
          },
          { id: 'add_billing_tag', type: 'action', action: { type: 'add_tag', tagId: 'billing' } },
        ],
        edges: [
          { from: 'trigger', to: 'mentions_billing' },
          { from: 'mentions_billing', to: 'add_billing_tag' },
        ],
      },
    },
  },
]

export function workflowTemplatesByCategory(
  category: WorkflowTemplateCategory
): WorkflowTemplate[] {
  return WORKFLOW_TEMPLATES.filter((t) => t.categories.includes(category))
}
