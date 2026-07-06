/**
 * Two-way inbox translation (P2-D.1).
 *
 * INCOMING (customer -> agent) is display-layer only: translating a customer
 * message NEVER mutates `conversation_messages.content`/`content_json`.
 * Translations are cached per (message, locale) in
 * `conversation_message_translations` -- keyed by locale (not just "the"
 * translation) because different teammates viewing the same message may have
 * different preferred languages. This mirrors the help-center auto-translate
 * precedent's (parentId, locale) -> content cache shape.
 *
 * OUTGOING (agent -> customer): when translation is active for the
 * conversation, a teammate's reply is translated into the customer's
 * language BEFORE it is sent -- the translation becomes the stored/sent
 * `content`, and the teammate's pre-translation original is preserved on
 * that same message's `metadata.translatedFrom` (see
 * packages/db/src/types.ts) rather than the cache table: unlike the incoming
 * direction, there's only ever one "original" per outgoing message, so a
 * per-viewer-language cache row doesn't apply.
 *
 * Both directions go through the same AI call shape as
 * help-center-auto-translate.service.ts: a chat-completion JSON contract,
 * `withRetry`, and `withUsageLogging` under the single 'inbox_translation'
 * pipeline step (metadata.stage distinguishes detect/incoming/outgoing).
 *
 * Customer-language detection is lazy and cached: `maybeDetectCustomerLanguage`
 * runs at most once per conversation, from the visitor's own recent messages,
 * and persists the result on `conversations.detected_customer_language` so it
 * is never recomputed on every read.
 */
import {
  db,
  eq,
  and,
  desc,
  isNull,
  conversations,
  conversationMessages,
  conversationMessageTranslations,
  user,
  type Conversation,
  type ConversationMessage,
  type TranslatedFromMetadata,
} from '@/lib/server/db'
import type { ConversationId, ConversationMessageId, UserId } from '@quackback/ids'
import { getOpenAI, stripCodeFences } from '@/lib/server/domains/ai/config'
import { getChatModel } from '@/lib/server/domains/ai/models'
import { withRetry } from '@/lib/server/domains/ai/retry'
import { withUsageLogging } from '@/lib/server/domains/ai/usage-log'
import { ValidationError, ForbiddenError, NotFoundError } from '@/lib/shared/errors'
import { canActAsAgent } from '@/lib/server/policy/conversation'
import type { Actor } from '@/lib/server/policy/types'
import type { TiptapContent } from '@/lib/shared/db-types'
import { TRANSLATION_UNAVAILABLE_MESSAGE } from '@/lib/shared/conversation/translation'
// translationStateFrom lives in conversation.query.ts (not here) so THIS module
// can import conversationToDTO from that same module without a circular
// import; re-exported here so callers have one place to import the P2-D.1
// translation API surface from.
import { conversationToDTO, translationStateFrom } from './conversation.query'
import { publishConversationUpdate } from '@/lib/server/realtime/conversation-channels'
import { logger } from '@/lib/server/logger'

export { translationStateFrom }

const log = logger.child({ component: 'conversation-translation' })

const PIPELINE_STEP = 'inbox_translation'
const RECENT_VISITOR_MESSAGES_FOR_DETECTION = 5
const DETECTION_TEXT_CHAR_LIMIT = 2000

/** Thrown when a translation call could not complete (AI unconfigured,
 *  network failure, or an unparseable/empty response). The outgoing send
 *  path uses this to BLOCK the send rather than silently deliver
 *  untranslated text the teammate never saw and didn't ask for. */
export class TranslationUnavailableError extends ValidationError {
  constructor(message = TRANSLATION_UNAVAILABLE_MESSAGE) {
    super('TRANSLATION_FAILED', message)
  }
}

/** The bare BCP-47 primary subtag, lowercased (e.g. "pt-BR" -> "pt"), so
 *  "same language" comparisons treat region/script variants as equal. */
export function primaryLanguageSubtag(tag: string | null | undefined): string | null {
  if (!tag) return null
  const primary = tag.trim().split('-')[0]
  return primary ? primary.toLowerCase() : null
}

/** Whether two language tags share a primary subtag. Two unset/unknown tags
 *  are never "the same" — there's nothing to compare. */
export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = primaryLanguageSubtag(a)
  const pb = primaryLanguageSubtag(b)
  return pa !== null && pa === pb
}

export function buildLanguageDetectionPrompt(text: string): { system: string; user: string } {
  const system = `You identify the primary language of customer support messages.
Respond with strict JSON only: {"language": "<BCP-47 tag or null>"}.
Use a short tag (e.g. "en", "fr", "pt"). If you genuinely cannot tell, respond {"language": null}.`
  return { system, user: text.slice(0, DETECTION_TEXT_CHAR_LIMIT) }
}

export function buildInboxTranslationPrompt(input: { text: string; targetLocale: string }): {
  system: string
  user: string
} {
  const system = `You are a professional translator for live customer-support conversations.
Translate the given text into the locale "${input.targetLocale}". Preserve tone and meaning;
do not add commentary, greetings, or explanations that are not present in the source text.
Return strict JSON only: {"content": "string"}`
  const user = JSON.stringify({ content: input.text })
  return { system, user }
}

/** Raw chat-completion call shared by detection + both translate directions,
 *  so all three go through the identical AI-config/retry/usage-logging path
 *  (matching the help-center-auto-translate precedent). Returns null when AI
 *  isn't configured for this feature — callers decide whether that's a
 *  silent skip (detection) or a blocking failure (translation). */
async function callInboxTranslationModel(
  stage: 'detect' | 'incoming' | 'outgoing',
  system: string,
  user: string,
  metadata: Record<string, unknown>
): Promise<string | null> {
  const openai = getOpenAI()
  const model = getChatModel('inboxTranslation')
  if (!openai || !model) return null

  const completion = await withUsageLogging(
    {
      pipelineStep: PIPELINE_STEP,
      callType: 'chat_completion',
      model,
      metadata: { stage, ...metadata },
    },
    () =>
      withRetry(() =>
        openai.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
        })
      ),
    (result) => ({
      inputTokens: result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.completion_tokens ?? 0,
      totalTokens: result.usage?.total_tokens ?? 0,
    })
  )
  return completion.choices[0]?.message?.content ?? null
}

/**
 * Best-effort customer-language detection from the visitor's own recent
 * messages, persisted once on the conversation row. Never throws: AI
 * misconfiguration, an empty thread, or an unparseable response all just
 * skip detection silently (mirrors queueAutoTranslateOnPublish's
 * error-swallow style) — this only powers a "nice to have" activation-
 * suggestion banner, never a blocking path.
 */
export async function maybeDetectCustomerLanguage(
  conversation: Conversation
): Promise<Conversation> {
  if (conversation.detectedCustomerLanguage) return conversation
  try {
    const rows = await db
      .select({ content: conversationMessages.content })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, conversation.id),
          eq(conversationMessages.senderType, 'visitor'),
          eq(conversationMessages.isInternal, false),
          isNull(conversationMessages.deletedAt)
        )
      )
      .orderBy(desc(conversationMessages.createdAt))
      .limit(RECENT_VISITOR_MESSAGES_FOR_DETECTION)

    const text = rows
      .map((r) => r.content)
      .filter(Boolean)
      .join('\n')
      .trim()
    if (!text) return conversation

    const { system, user: userMessage } = buildLanguageDetectionPrompt(text)
    const raw = await callInboxTranslationModel('detect', system, userMessage, {
      conversationId: conversation.id,
    })
    if (!raw) return conversation

    const parsed = JSON.parse(stripCodeFences(raw)) as { language?: string | null }
    const language = primaryLanguageSubtag(parsed.language)
    if (!language) return conversation

    const [updated] = await db
      .update(conversations)
      .set({ detectedCustomerLanguage: language })
      .where(eq(conversations.id, conversation.id))
      .returning()
    return updated ?? conversation
  } catch (err) {
    log.error({ err, conversation_id: conversation.id }, 'customer language detection failed')
    return conversation
  }
}

async function getCachedIncomingTranslation(messageId: ConversationMessageId, locale: string) {
  const [row] = await db
    .select()
    .from(conversationMessageTranslations)
    .where(
      and(
        eq(conversationMessageTranslations.conversationMessageId, messageId),
        eq(conversationMessageTranslations.locale, locale)
      )
    )
    .limit(1)
  return row ?? null
}

export interface MessageTranslationResult {
  content: string
  /** True when this came from the cache table (no AI call this time). */
  cached: boolean
}

/**
 * Translate ONE customer message for display, cache-hit or fresh. Never
 * mutates `conversation_messages` — the translation lives only in
 * `conversation_message_translations`, keyed by (messageId, locale).
 */
export async function translateIncomingMessage(
  message: Pick<ConversationMessage, 'id' | 'content'>,
  targetLocale: string
): Promise<MessageTranslationResult> {
  const locale = primaryLanguageSubtag(targetLocale) ?? targetLocale

  const cached = await getCachedIncomingTranslation(message.id, locale)
  if (cached) return { content: cached.content, cached: true }

  const { system, user: userMessage } = buildInboxTranslationPrompt({
    text: message.content,
    targetLocale: locale,
  })
  const raw = await callInboxTranslationModel('incoming', system, userMessage, {
    conversationMessageId: message.id,
    targetLocale: locale,
  })
  if (!raw) throw new TranslationUnavailableError()

  let parsed: { content?: string }
  try {
    parsed = JSON.parse(stripCodeFences(raw)) as { content?: string }
  } catch (err) {
    log.error({ err, message_id: message.id }, 'inbox translation: unparseable AI response')
    throw new TranslationUnavailableError()
  }
  if (!parsed.content) throw new TranslationUnavailableError()

  await db
    .insert(conversationMessageTranslations)
    .values({ conversationMessageId: message.id, locale, content: parsed.content })
    .onConflictDoUpdate({
      target: [
        conversationMessageTranslations.conversationMessageId,
        conversationMessageTranslations.locale,
      ],
      set: { content: parsed.content, updatedAt: new Date() },
    })

  return { content: parsed.content, cached: false }
}

/**
 * Translate a teammate's outgoing reply into the customer's language before
 * it is sent. Throws `TranslationUnavailableError` on any failure — the
 * caller (sendAgentMessageFn) BLOCKS the send rather than deliver
 * untranslated text the teammate expected to be translated.
 */
export async function translateOutgoingContent(
  text: string,
  targetLocale: string
): Promise<string> {
  const locale = primaryLanguageSubtag(targetLocale) ?? targetLocale
  const { system, user: userMessage } = buildInboxTranslationPrompt({ text, targetLocale: locale })
  const raw = await callInboxTranslationModel('outgoing', system, userMessage, {
    targetLocale: locale,
  })
  if (!raw) throw new TranslationUnavailableError()

  let parsed: { content?: string }
  try {
    parsed = JSON.parse(stripCodeFences(raw)) as { content?: string }
  } catch (err) {
    log.error({ err }, 'inbox translation: unparseable AI response (outgoing)')
    throw new TranslationUnavailableError()
  }
  if (!parsed.content) throw new TranslationUnavailableError()
  return parsed.content
}

export interface ResolveOutgoingReplyInput {
  conversationId: ConversationId
  content: string
  contentJson: TiptapContent | null
  /** The sending teammate — used to resolve their own language preference
   *  (P2-0.3) as the "source" locale recorded on `translatedFrom`. */
  teammateUserId: UserId
}

export interface ResolveOutgoingReplyResult {
  content: string
  contentJson: TiptapContent | null
  /** Set only when this reply was actually translated — the caller
   *  (sendAgentMessageFn) attaches this to the new message's metadata. */
  translatedFrom?: TranslatedFromMetadata
}

/**
 * Decide whether an outgoing agent reply should be translated before it is
 * sent, and if so, translate it. Called from sendAgentMessageFn BEFORE the
 * message is persisted — translation happens synchronously on the send path
 * so the stored/broadcast/emailed content is always what the customer should
 * see (never an untranslated draft the teammate expected to be translated).
 *
 * Passes the content through untouched (no AI call) when: translation isn't
 * active for the conversation, the customer's language hasn't been detected
 * yet, there's no text to translate, or the teammate is already writing in
 * the customer's language. Otherwise translates and throws
 * `TranslationUnavailableError` on failure — the caller must treat that as a
 * BLOCKING error, not fall back to sending untranslated silently.
 */
export async function resolveOutgoingReplyTranslation(
  input: ResolveOutgoingReplyInput
): Promise<ResolveOutgoingReplyResult> {
  const passthrough = (): ResolveOutgoingReplyResult => ({
    content: input.content,
    contentJson: input.contentJson,
  })

  if (!input.content.trim()) return passthrough()

  const context = await getInboxTranslationContext(input.conversationId)
  if (!context?.enabled || !context.customerLocale) return passthrough()

  const [teammateRow] = await db
    .select({ preferredLanguage: user.preferredLanguage })
    .from(user)
    .where(eq(user.id, input.teammateUserId))
    .limit(1)
  const teammateLocale = primaryLanguageSubtag(teammateRow?.preferredLanguage) ?? 'en'

  if (sameLanguage(teammateLocale, context.customerLocale)) return passthrough()

  const translated = await translateOutgoingContent(input.content, context.customerLocale)
  const targetLocale = primaryLanguageSubtag(context.customerLocale) ?? context.customerLocale
  return {
    content: translated,
    // Rich formatting (bold/lists/embeds) is not preserved through a
    // translated send in this slice — the customer-facing content becomes
    // plain translated text. The teammate's original (with its formatting)
    // remains available via "Show original".
    contentJson: null,
    translatedFrom: { originalContent: input.content, sourceLocale: teammateLocale, targetLocale },
  }
}

export interface InboxTranslationContext {
  enabled: boolean
  /** The customer's detected language, or null when nothing has been
   *  detected yet (nothing to translate against). */
  customerLocale: string | null
}

/** Cheap read used by the send path to decide whether an outgoing reply
 *  should be translated, without loading (and re-validating) the full
 *  conversation row the way the service's other mutators do. */
export async function getInboxTranslationContext(
  conversationId: ConversationId
): Promise<InboxTranslationContext | null> {
  const [row] = await db
    .select({
      translationEnabled: conversations.translationEnabled,
      detectedCustomerLanguage: conversations.detectedCustomerLanguage,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)
  if (!row) return null
  return { enabled: row.translationEnabled, customerLocale: row.detectedCustomerLanguage }
}

async function loadConversationOr404(conversationId: ConversationId): Promise<Conversation> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)
  if (!row) throw new NotFoundError('CONVERSATION_NOT_FOUND', 'Conversation not found')
  return row
}

/** Manual per-conversation activation toggle (ACTIVATION). Turning
 *  translation ON clears any earlier dismissal, so a later manual turn-off
 *  can surface the suggestion banner again if the detected language still
 *  differs from the viewing teammate's. */
export async function setInboxTranslationEnabled(
  conversationId: ConversationId,
  enabled: boolean,
  actor: Actor
): Promise<Conversation> {
  const decision = canActAsAgent(actor)
  if (!decision.allowed) throw new ForbiddenError('FORBIDDEN', decision.reason)
  const existing = await loadConversationOr404(conversationId)
  const [updated] = await db
    .update(conversations)
    .set({
      translationEnabled: enabled,
      translationDismissedAt: enabled ? null : existing.translationDismissedAt,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId))
    .returning()
  const dto = await conversationToDTO(updated, 'agent')
  publishConversationUpdate(conversationId, dto)
  return updated
}

/** Dismiss the auto-suggest banner ("This customer writes in French...") for
 *  this conversation. Persisted on the row, not per-teammate — a shared
 *  workspace decision, like the toggle itself. */
export async function dismissInboxTranslationSuggestion(
  conversationId: ConversationId,
  actor: Actor
): Promise<Conversation> {
  const decision = canActAsAgent(actor)
  if (!decision.allowed) throw new ForbiddenError('FORBIDDEN', decision.reason)
  await loadConversationOr404(conversationId)
  const [updated] = await db
    .update(conversations)
    .set({ translationDismissedAt: new Date(), updatedAt: new Date() })
    .where(eq(conversations.id, conversationId))
    .returning()
  const dto = await conversationToDTO(updated, 'agent')
  publishConversationUpdate(conversationId, dto)
  return updated
}
