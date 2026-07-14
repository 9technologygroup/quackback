/**
 * §7.3 Escalation & control (scenarios 6–9). Quinn decides THAT it hands off,
 * never where. Scenario 9 (silence rule) is deterministic — no model call.
 */
import type { Scenario } from '../types'

export const escalationScenarios: Scenario[] = [
  {
    id: '06',
    title: 'Explicit "talk to a human" → handoff, no answer-shaped filler',
    roles: ['customer_support'],
    surface: 'widget',
    prompt: 'I do not want a bot. Please connect me to a human agent right now.',
    structural: [{ type: 'handoff', reasonOneOf: ['explicit_request'] }, { type: 'noCitations' }],
  },
  {
    id: '07',
    title: 'Frustration signals → handoff with the frustration reason',
    roles: ['customer_support'],
    surface: 'widget',
    thread: [
      { sender: 'customer', content: 'This is the third time I am asking and nothing works.' },
      { sender: 'assistant', content: 'I am sorry for the trouble. Let me try to help.' },
      {
        sender: 'customer',
        content:
          'I am absolutely fed up. This product is garbage and you keep wasting my time. Fix it NOW.',
      },
    ],
    structural: [{ type: 'handoff', reasonOneOf: ['frustration'] }],
  },
  {
    id: '08',
    title: 'Low-confidence judgment case → prefers handoff over confident wrongness',
    roles: ['customer_support'],
    surface: 'widget',
    // No KB seeded and a high-stakes, workspace-specific ask the model cannot
    // safely guess at — it should hand off (or honestly report inability)
    // rather than invent an answer. Judgment-variance scenario: run 5x.
    repeats: 5,
    stabilityThreshold: 0.6,
    prompt:
      'My company is mid-acquisition. Will migrating our workspace to a new legal entity void our signed data-processing agreement and trigger the liability clause?',
    structural: [{ type: 'status', oneOf: ['answered', 'cannot_answer'] }, { type: 'noCitations' }],
  },
  {
    id: '09',
    title: 'Silence rule — a human teammate replied last, so Quinn must skip',
    roles: ['customer_support'],
    surface: 'widget',
    thread: [
      { sender: 'customer', content: 'Is anyone there? I need help with my invoice.' },
      { sender: 'assistant', content: 'Hi! I can help with that.' },
      { sender: 'human_agent', content: "Hi, this is Dana from support — I've got this one." },
      { sender: 'customer', content: 'Thanks Dana.' },
    ],
    structural: [{ type: 'suppressed' }],
  },
]
