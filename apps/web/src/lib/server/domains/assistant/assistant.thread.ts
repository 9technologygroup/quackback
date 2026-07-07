/**
 * Rows-to-turns mapper for the Quinn messenger wiring: conversation message DTOs
 * become the `AssistantThreadMessage[]` the runtime reasons over. Kept as a pure
 * mapper (unit-tested) plus a thin read-only loader over the shared
 * `listMessages` read.
 *
 * Sender mapping:
 *   - a 'visitor' message           → 'customer'
 *   - an 'agent' message by Quinn    → 'assistant' (matched on the service
 *                                      principal id)
 *   - an 'agent' message by anyone   → 'human_agent'
 * System notices and text-less messages are not turns and are skipped; internal
 * notes and soft-deleted rows are filtered in SQL, so they never reach the
 * mapper (and no longer consume window slots).
 */
import type { PrincipalId, ConversationId } from '@quackback/ids'
import {
  listMessages,
  listConversationMessagesForGrounding,
} from '@/lib/server/domains/conversation/conversation.query'
import type { ConversationMessageDTO } from '@/lib/shared/conversation/types'
import type { AssistantThreadMessage } from './assistant.runtime'

/** Newest recent turns to hand the model — enough context without unbounded prompt growth. */
export const ASSISTANT_THREAD_WINDOW = 40

/** Map conversation-message DTOs (oldest-first) to assistant thread turns. */
export function mapRowsToThreadMessages(
  messages: ConversationMessageDTO[],
  assistantPrincipalId: PrincipalId
): AssistantThreadMessage[] {
  const out: AssistantThreadMessage[] = []
  for (const m of messages) {
    // System notices are status records, not turns.
    if (m.senderType === 'system') continue
    const content = m.content?.trim()
    // Image/embed-only messages carry no text for the model to reason over.
    if (!content) continue
    if (m.senderType === 'visitor') {
      out.push({ sender: 'customer', content })
    } else {
      out.push({
        sender: m.author?.principalId === assistantPrincipalId ? 'assistant' : 'human_agent',
        content,
      })
    }
  }
  return out
}

/**
 * Load a conversation's recent thread (oldest-first) as message DTOs. Internal
 * notes are excluded in SQL by default (`includeInternal: false`), so the window
 * is spent only on customer-visible turns — the byte-identical default every
 * existing caller (the summary paths, attribute classification, the
 * orchestrator) relies on. The copilot grounding block opts into
 * `includeInternal: true` so Quinn can see a teammate's notes on the open thread
 * (D1); no other caller passes it, and no non-team surface ever should. The
 * caller pairs these with the assistant principal id through
 * `mapRowsToThreadMessages` — the raw read is principal-independent, so it can
 * run in parallel with the principal lookup.
 *
 * `all: true` bypasses the newest-`ASSISTANT_THREAD_WINDOW` window and loads the
 * whole thread (oldest-first), for the copilot grounding block whose
 * `budgetTranscript` needs the thread head as well as its tail; the windowed
 * default would drop the customer's original request on a long conversation.
 * `limit` is ignored when `all` is set.
 */
export async function loadConversationThread(
  conversationId: ConversationId,
  opts: { limit?: number; includeInternal?: boolean; all?: boolean } = {}
): Promise<ConversationMessageDTO[]> {
  if (opts.all) {
    return listConversationMessagesForGrounding(conversationId, {
      includeInternal: opts.includeInternal ?? false,
    })
  }
  const { messages } = await listMessages(conversationId, {
    includeInternal: opts.includeInternal ?? false,
    limit: opts.limit ?? ASSISTANT_THREAD_WINDOW,
  })
  return messages
}
