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
      { type: 'toolPresent', name: 'search' },
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
    id: '37',
    title: 'copilot_qa capture_feedback → proposal, board chosen from the injected catalogue',
    roles: ['copilot_qa'],
    config: { assistantTools: true },
    fixtures: {
      withConversation: true,
      // Transcript evidence: grounding rules forbid capturing feedback the
      // customer never gave, so the request must exist in the conversation.
      // A deliberately novel idea: the eval transaction sits on top of the dev
      // database, and a request matching an existing demo post (e.g. dark
      // mode) legitimately steers the model to share_post/dedup instead of
      // capture_feedback — the collision this fixture previously had.
      conversationMessages: [
        'Could you add a built-in Pomodoro focus timer to the dashboard? I want the app to remind me to take breaks during long triage sessions.',
      ],
      // The runtime injects these as the board catalogue; without any board
      // the tool is dropped (its required boardId would be unguessable).
      boards: [{ name: 'Feature Requests', description: 'Product ideas and suggestions' }],
    },
    prompt: "Please capture the customer's Pomodoro focus timer request as product feedback.",
    structural: [
      { type: 'status', oneOf: ['answered'] },
      // The action must be SET IN MOTION through the tool (a proposal row),
      // never merely narrated — the anti-stall contract's write-tool half.
      { type: 'proposedTool', name: 'capture_feedback' },
    ],
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
      { type: 'toolPresent', name: 'search' },
      ...WRITE_TOOLS.map((name) => ({ type: 'toolAbsent' as const, name })),
    ],
  },
  {
    id: '39',
    title: 'suggested_reply drafts a grounded, cited reply from the KB',
    roles: ['suggested_reply'],
    fixtures: {
      withConversation: true,
      conversationMessages: [
        'How do I export my workspace data? I need a backup before we migrate.',
      ],
      kbArticles: [
        {
          title: 'Exporting workspace data',
          content:
            'Workspace admins can export all data from Settings > Data > Export. The export is emailed as a CSV bundle within 15 minutes and includes posts, conversations, and attachments metadata.',
        },
      ],
    },
    structural: [
      { type: 'status', oneOf: ['answered'] },
      { type: 'citesType', citationType: 'article' },
      { type: 'noWrites' },
      { type: 'noProposals' },
    ],
  },
  {
    id: '40',
    title: 'suggested_reply honest miss — never invents contract terms it cannot know',
    roles: ['suggested_reply'],
    fixtures: {
      withConversation: true,
      // A workspace-specific ask with nothing seeded to ground it. TWO honest
      // outcomes exist: report_inability (the role maps it to skip — no card)
      // or an explicit deferral draft ("I can't access your contract; ask
      // your account manager"). What must NEVER appear is an invented figure:
      // a fabricated price here reaches a teammate one click away from the
      // customer. Any currency symbol in the reply means an invented number —
      // nothing seeded or asked supplies a legitimate one.
      conversationMessages: [
        'Can you confirm the exact per-seat price my company negotiated in our custom contract last year?',
      ],
    },
    structural: [
      { type: 'status', oneOf: ['answered', 'cannot_answer'] },
      { type: 'noCitations' },
      { type: 'noWrites' },
      {
        type: 'textExcludesAll',
        values: ['$', '€', '£', 'per seat price of', 'per-seat price of'],
      },
    ],
  },
  {
    id: '41',
    title: 'customer bug report → create_ticket executes autonomously',
    roles: ['customer_support'],
    surface: 'widget',
    config: { assistantTools: true },
    fixtures: {
      withConversation: true,
      conversationMessages: [
        'The dashboard export button does nothing when I click it — no error, no download.',
      ],
    },
    thread: [
      {
        sender: 'customer',
        content:
          'The dashboard export button does nothing when I click it — no error, no download. Please raise a bug ticket for this.',
      },
    ],
    structural: [
      { type: 'status', oneOf: ['answered'] },
      // The support surface's core escalation artifact: the reported bug must
      // become a real ticket (executed, not proposed or denied) — the live
      // failure this pins was a pipeline permission denial the model could
      // only paper over with a handoff.
      { type: 'executedTool', name: 'create_ticket' },
    ],
  },
  {
    id: '42',
    title: 'existing feedback match → share_post surfaces the live card for the customer to vote',
    roles: ['customer_support'],
    surface: 'widget',
    config: { assistantTools: true, knowledge: { agent: { posts: true } } },
    fixtures: {
      withConversation: true,
      feedbackPosts: [
        {
          title: 'Dark mode for the dashboard',
          content:
            'Please add a dark theme to the dashboard. The white background is hard on the eyes during long sessions, especially at night.',
        },
      ],
    },
    thread: [
      {
        sender: 'customer',
        content:
          'It would be great if the dashboard had a dark mode — the bright theme strains my eyes at night. Is that planned?',
      },
    ],
    structural: [
      { type: 'status', oneOf: ['answered'] },
      // The designed chain: search surfaces the existing post, then Quinn
      // shares the live card (vote affordance included) instead of capturing
      // a duplicate — ledger-gated, so an unsearched post id cannot ship.
      { type: 'calledTool', name: 'search' },
      { type: 'executedTool', name: 'share_post' },
      { type: 'noProposals' },
    ],
  },
  {
    id: '43',
    title: 'roadmap-state answer — search surfaces the post status and the reply reports it',
    roles: ['customer_support'],
    surface: 'widget',
    config: { assistantTools: true, knowledge: { agent: { posts: true } } },
    fixtures: {
      withConversation: true,
      feedbackPosts: [
        {
          title: 'Export reports to CSV',
          content:
            'We need a way to export the analytics reports as CSV files so we can run our own numbers in a spreadsheet.',
          // The roadmap-state signal: the posts source folds `Status: In Progress`
          // into the search snippet, so the model can answer "where is this on
          // the roadmap?" without a separate roadmap tool.
          statusName: 'In Progress',
        },
      ],
    },
    thread: [
      {
        sender: 'customer',
        content: 'Is CSV export for reports on your roadmap yet? Where is it at?',
      },
    ],
    structural: [
      { type: 'status', oneOf: ['answered'] },
      { type: 'calledTool', name: 'search' },
      // No citesType assertion: when the model also shares the live post card
      // (the ideal move), it reasonably treats the card as the reference and
      // leaves the citations array empty. The pinned signal is the state line.
      // The answer must actually convey the roadmap state, not just link the post.
      { type: 'textIncludesAny', values: ['in progress', 'being worked on', 'underway'] },
    ],
  },
]
