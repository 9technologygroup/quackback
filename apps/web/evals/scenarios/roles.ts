/**
 * §7.3 Roles & actions (scenarios 20–23), all structural, no judge. These
 * encode the D14 write-tool contract: suggested_reply never writes;
 * customer_support with the flag on executes autonomously; copilot_qa proposes;
 * flag off removes write tools from the assembled set entirely.
 */
import type { Scenario } from '../types'

const PLAN_TIER_ATTR = { key: 'plan_tier', label: 'Plan tier', fieldType: 'text' as const }

const WRITE_TOOLS = ['set_attribute', 'end_conversation', 'create_ticket', 'capture_feedback']

export const roleScenarios: Scenario[] = [
  {
    id: '20',
    title: 'suggested_reply never writes — write tools absent from its tool set',
    kind: 'toolset',
    roles: ['suggested_reply'],
    config: { assistantTools: true },
    fixtures: { withConversation: true },
    structural: [
      { type: 'toolPresent', name: 'search_knowledge' },
      ...WRITE_TOOLS.map((name) => ({ type: 'toolAbsent' as const, name })),
    ],
  },
  {
    id: '21',
    title: 'customer_support with assistantTools on executes set_attribute directly (D14)',
    roles: ['customer_support'],
    surface: 'widget',
    config: { assistantTools: true },
    fixtures: { withConversation: true, attributes: [PLAN_TIER_ATTR] },
    prompt:
      'Just so you have it on file for your records: my account is on the Enterprise plan tier. ' +
      'Please note that down as a plan_tier attribute on this conversation.',
    // Execute, not propose: the write settles as an audit 'executed' outcome
    // with no pending-action row (the noProposals guard confirms the latter).
    structural: [{ type: 'executedTool', name: 'set_attribute' }, { type: 'noProposals' }],
  },
  {
    id: '22',
    title: 'copilot_qa write call → proposal card entry with the right payload',
    roles: ['copilot_qa'],
    config: { assistantTools: true },
    fixtures: { withConversation: true, attributes: [PLAN_TIER_ATTR] },
    prompt:
      'Please tag this conversation with a plan_tier attribute set to Enterprise so it shows on our reports.',
    structural: [{ type: 'proposedTool', name: 'set_attribute' }],
  },
  {
    id: '23',
    title: 'assistantTools off → write tools absent from the assembled toolset',
    kind: 'toolset',
    roles: ['customer_support'],
    surface: 'widget',
    config: { assistantTools: false },
    fixtures: { withConversation: true },
    structural: [
      { type: 'toolPresent', name: 'search_knowledge' },
      ...WRITE_TOOLS.map((name) => ({ type: 'toolAbsent' as const, name })),
    ],
  },
]
