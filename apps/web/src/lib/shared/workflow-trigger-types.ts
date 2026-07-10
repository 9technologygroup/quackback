/**
 * The trigger types a workflow can dispatch on — every event
 * `eventToWorkflowTrigger` (apps/web/src/lib/server/domains/workflows/event-trigger.ts)
 * maps to a WorkflowTrigger, none more. This is the single canonical list, shared
 * by both sides the same way other client/server constants live under lib/shared
 * (e.g. routing.ts): the authoring validation (workflow.schemas.ts) rejects a
 * typo'd or stale `triggerType` on save, and the builder's trigger picker
 * (workflow-graph.ts's TRIGGER_TYPES) renders from the same array so the two can
 * never drift.
 *
 * Keep in sync with `eventToWorkflowTrigger`'s switch by hand — adding a new
 * dispatchable event there needs an entry here too, or workflows can never be
 * authored against it (create/update would reject the new triggerType as
 * unknown).
 */
export const DISPATCHABLE_TRIGGER_TYPES = [
  'conversation.created',
  'conversation.status_changed',
  'conversation.assigned',
  'conversation.priority_changed',
  'conversation.csat_submitted',
  'message.created',
  'message.note_created',
  'assistant.handed_off',
] as const

export type DispatchableTriggerType = (typeof DISPATCHABLE_TRIGGER_TYPES)[number]
