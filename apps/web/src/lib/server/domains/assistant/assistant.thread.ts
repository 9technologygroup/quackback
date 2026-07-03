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
import { listMessages } from '@/lib/server/domains/conversation/conversation.query'
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
 * notes are excluded in SQL via `includeInternal: false`, so the window is spent
 * only on customer-visible turns. The caller pairs these with the assistant
 * principal id through `mapRowsToThreadMessages` — the raw read is
 * principal-independent, so it can run in parallel with the principal lookup.
 */
export async function loadConversationThread(
  conversationId: ConversationId,
  limit: number = ASSISTANT_THREAD_WINDOW
): Promise<ConversationMessageDTO[]> {
  const { messages } = await listMessages(conversationId, { includeInternal: false, limit })
  return messages
}
