/**
 * Assistant domain: shared retrieval, one-shot answer synthesis, and the
 * in-product AI agent (Quinn) — its workspace identity, involvement record, tool
 * layer, and the TanStack AI runtime seam.
 *
 * Retrieval was built for help-center Ask AI first; the same module backs
 * Quinn's search_knowledge tool. The runtime seam is what the next wave's
 * messenger wiring and the admin sandbox both call.
 */
export {
  retrieveKbArticles,
  KB_ASK_TOP_K,
  KB_ASK_CONTEXT_CHARS,
  RELATED_SIMILARITY_FLOOR,
  type RetrievedKbArticle,
  type RetrieveKbArticlesOptions,
} from './retrieval'
export {
  synthesizeAnswer,
  isAskAiConfigured,
  buildAskAiSystemPrompts,
  AskAiNotConfiguredError,
  ASK_AI_MISS_FALLBACK,
  type AskAiAnswer,
  type AskAiAnswerKind,
  type AskAiSource,
  type SynthesizeAnswerParams,
} from './synthesis'

// Quinn — identity
export {
  ensureAssistantPrincipal,
  getAssistantPrincipal,
  ASSISTANT_DEFAULT_NAME,
} from './assistant.principal'

// Quinn — involvement record + outcome semantics
export {
  openInvolvement,
  getActiveInvolvement,
  getLatestInvolvement,
  recordAssistantAnswer,
  recordHandoff,
  recordOutcome,
  voidAssumedResolutionForConversation,
  finalizeStaleAssistantInvolvements,
  setInvolvementRating,
  assumedResolutionEligible,
  confirmedResolutionEligible,
  outcomeStatus,
  ASSUMED_RESOLUTION_INACTIVITY_MINUTES,
  type AssistantInvolvement,
  type OutcomeContext,
} from './assistant.involvement'

// Quinn — messenger thread mapping + handover copy
export {
  mapRowsToThreadMessages,
  loadConversationThread,
  ASSISTANT_THREAD_WINDOW,
} from './assistant.thread'
export { buildAssistantHandoverMessage } from './assistant.handover'

// Quinn — tools + runtime
export {
  searchKnowledgeTool,
  getConversationContextTool,
  createAssistantTools,
  type AssistantCitation,
  type AssistantToolContext,
} from './assistant.tools'
export {
  runAssistantTurn,
  isAssistantConfigured,
  respondEligible,
  assembleCitations,
  decideEscalation,
  isSubstantiveAnswer,
  buildAssistantSystemPrompt,
  AssistantNotConfiguredError,
  ASSISTANT_MAX_ITERATIONS,
  type AssistantTurnInput,
  type AssistantTurnResult,
  type AssistantThreadMessage,
  type AssistantThreadSender,
  type EscalationOutcome,
  type EscalationReason,
} from './assistant.runtime'
