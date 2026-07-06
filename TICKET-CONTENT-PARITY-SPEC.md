# Ticket & Conversation Content Parity Spec

**Goal:** bring the ticket (and conversation) message experience up to the rich-content
bar set by feedback posts — rich text, images, formatting — consistently **at every
layer: schema, editor, rendering, serialization, API/MCP, export, webhooks, email.**

**Status:** IMPLEMENTED on `next` (2026-07-06). Phases 0–4 landed across ~25 commits
(session `01CQZohjsZrSKNhckR2t8wKQ`); Phase 5 (Quinn convergence) deferred as planned.
An adversarial review pass hardened the inbound-email ingestion (upload cap, MIME depth
bound, quote-trim tightening, fallback-label src guard). Local-only spec.

**Shipped summary:**
- Editor unified: `RichTextEditor` + `CONVERSATION_EDITOR_FEATURES` / `NOTE` / `VISITOR`
  presets replaces the hand-rolled `ConversationRichComposer`/`ConversationNoteEditor`
  (both deleted). Agent replies/notes, ticket thread, portal reply, both new-ticket
  dialogs, and the new-conversation dialog all author support-grade rich content.
- Storage: `conversation_messages` needed no migration; `content` derives from
  `contentJson` server-side (`tiptapJsonToText`). Visitor inline images are restricted to
  trusted origins on every visitor-sender write path.
- Transport parity: REST, MCP (markdown in/out), transcript export, and new
  `ticket.replied`/`ticket.note_added` webhooks all carry rich content.
- Email: inbound HTML→`contentJson` (quote-trim + line-boundary + sanitize + turndown),
  MIME attachment + cid-inline rehosting through the trust chain, and full-body outbound
  rendering with a `?email=1` image-proxy hint.

---

## 1. The key reframing: "tickets" is really the shared message layer

The instinct — "enrich ticketing to match posts" — is directionally right, but the
reality is more specific and, happily, more tractable than a from-scratch build:

- **Tickets and conversations are one surface, not two.** Ticket descriptions, agent
  replies, and internal notes are all rows in `conversation_messages`
  (`packages/db/src/schema/conversation.ts`), a polymorphic table whose parent is
  `conversation_id` **XOR** `ticket_id` (enforced by
  `CHECK num_nonnulls(conversation_id, ticket_id) = 1`). Tickets carry **no content
  column of their own** (`tickets.title` is the only text field).
- **They already share the same composer and renderer.** `ticket-thread.tsx`,
  `agent-conversation-thread.tsx`, and the visitor `visitor-conversation-thread.tsx`
  all reuse `ConversationRichComposer` (reply), `ConversationNoteEditor` (note), and
  `AgentMessageBubble`/`VisitorMessageBubble` (render). There is **no richness gap
  between tickets and conversations** — fixing one fixes both.

**Consequence:** the unit of work is "the `conversation_messages` content layer,"
not "tickets." Every change below lands on tickets **and** conversations at once.

## 2. Current state — the richness ladder

Five tiers exist today, from richest to poorest:

| Tier | Surfaces | Editor | Storage | Images |
|---|---|---|---|---|
| **1 — Document** | Posts, changelog, help-center articles, portal welcome | `RichTextEditor` (full `EditorFeatures`) | `contentJson` **primary** + derived `content` markdown | Resizable, inline; external images rehosted |
| **2 — Comment** | Post comments (portal/widget/admin) | `RichTextEditor` + `COMMENT_EDITOR_FEATURES` | `contentJson` primary | **Off** (deliberate) |
| **3 — Chat reply/note** | Conversation + **ticket** replies & notes | `ConversationRichComposer` / `ConversationNoteEditor` (hand-rolled, **not** `RichTextEditor`) | `content` (plaintext) primary; `contentJson` **optional** | `chatImage` node — **fixed size**, non-resizable; notes have **no** inline image |
| **4 — Plaintext** | **New ticket (agent + portal)**, **portal ticket reply**, new-conversation dialog, macros | bare `<Textarea>` | `content` only; `contentJson` **always null** | **None** |
| **5 — Email** | Inbound/outbound email channel | n/a | plaintext only | inbound images/attachments **silently dropped** |

The two poles the user is comparing — "posts (rich)" vs "tickets (poor)" — are Tier 1
vs a mix of Tiers 3–5. Tier 3 is a **deliberately stripped tiptap**, not a plaintext
box, so "tickets have no rich editor" is only true for ticket *creation* and *portal
replies* (Tier 4) and for email (Tier 5).

## 3. Layer-by-layer gap analysis

### 3.1 Schema (`packages/db/src/schema/conversation.ts`) — **mostly already parity**

`conversation_messages` already has the same content-bearing columns as posts:

- `content: text NOT NULL` — always-populated plaintext mirror; source of the generated
  `search_vector` tsvector.
- `contentJson: jsonb $type<TiptapContent>` — nullable rich doc, sanitized on write by
  `sanitizeTiptapContent` (shared allowlist, identical to posts).
- `attachments: jsonb $type<ConversationAttachment[]>` — `{url,name,contentType,size}`,
  capped at `MAX_CONVERSATION_ATTACHMENTS = 10`, 5 MB/file.
- `citations`, `metadata` — AI grounding + channel provenance.

**Gap:** essentially none at the DB level. The columns exist; `contentJson` is simply
underused because most write paths never populate it. `search_vector` indexes `content`
only — acceptable **if** `content` is kept a faithful plaintext mirror of `contentJson`
(today it is derived client-side via `editor.getText()`; we should also derive/validate
it server-side, mirroring how posts derive `content` from `contentJson`).

### 3.2 Editor / compose

| Surface | File | Today | Gap |
|---|---|---|---|
| Agent reply | `admin/conversation/conversation-rich-composer.tsx` | tiptap, `StarterKit.configure({ heading:false, codeBlock:false, horizontalRule:false, link:false })` + `chatImage` (fixed) + embed + emoji; **no mentions** | no code blocks, no headings, no resizable images |
| Agent note | `admin/conversation/conversation-note-editor.tsx` | tiptap + `TeamMentionExtension` + embed; **no inline image node** | can't drop an image inline into a note |
| Agent new ticket | `admin/tickets/new-ticket-dialog.tsx` | bare `<Textarea>` (maxLength 4000) | **no rich text, no image** — `contentJson` always null |
| Portal new ticket | `portal/new-portal-ticket-dialog.tsx` | bare `<Textarea>` | same |
| Portal ticket reply | `routes/_portal/support.ticket.$ticketId.tsx` | bare `<Textarea>`, sends `content` only | **frontend-only gap** — backend already accepts `contentJson`/`attachments` |
| New conversation | `admin/conversation/new-conversation-dialog.tsx` | bare `<Textarea>` | no rich text |

**Architectural note:** the conversation composers are **hand-rolled on
`@tiptap/react`**, independent of the shared `RichTextEditor` (they reuse only helper
exports). This is the root cause of drift — every feature added to `RichTextEditor`
(resizable images, code blocks, tables, slash menu) has to be re-implemented to reach
tickets. `RichTextEditor` already has an `enterAsHardBreak` flag (chat-style Enter) and
`EditorFeatures` toggles, so it can express the chat preset directly.

### 3.3 Rendering — **already parity where `contentJson` exists**

`AgentMessageBubble`/`VisitorMessageBubble` (`components/conversation/message-bubble.tsx`)
and `NoteContent` already branch to `RichTextContent` (JSON→HTML→DOMPurify) when
`contentJson` is present, falling back to `whitespace-pre-wrap` plaintext otherwise.
`generateContentHTML` handles every node type including `chatImage`, `resizableImage`,
`quackbackEmbed`, `mention`, `emoji`, `youtube`. **No render work needed** once
`contentJson` gets populated — the display path is ready. One exception: AI/Quinn replies
bypass `contentJson` and render via a bespoke `parseMarkdownLite` (see 3.7).

### 3.4 Serialization — helpers exist, not wired to tickets

`markdown-tiptap.ts` already has `markdownToTiptapJson`, `contentJsonToMarkdown`,
`tiptapJsonToMarkdown`. Posts/changelog/help-center use them on every API/MCP read/write;
**tickets use none of them.** So markdown-in / markdown-out for ticket content over
API/MCP has no bridge.

### 3.5 API / MCP — plaintext only, strips rich fields

- **MCP** (`mcp/tools/tickets.ts`): `create_ticket`, `reply_to_ticket`, `add_ticket_note`
  accept `content: string` only — no `contentJson`, no `attachments`. Reads
  (`get_ticket`, `list_tickets`) return `content` only.
- **REST v1** (`routes/api/v1/tickets/`): **read-only** (no create/reply/note endpoint
  registered at all). `serializeTicketMessage` (`-serialize.ts`) strips `contentJson`,
  `attachments`, and `citations` entirely.

### 3.6 Export & webhooks — silently lossy

- **Transcript export** (`conversation.transcript.ts` → `renderConversationTranscript`)
  renders `m.content` only (discrete `attachments[]` entries DO print, line 65). An
  image-only or embed-only message (empty `content`, populated `contentJson`) exports
  as literally `"(no text content)"` — **inline images are lost.**
- **Webhooks** (`ticket.webhooks.ts`): only `ticket.created` / `ticket.status_changed` /
  `ticket.assigned` fire. There is **no `ticket.replied` / `ticket.note_added`** event,
  so no reply/note content — rich or plain — ever reaches a webhook consumer.

### 3.7 AI / Quinn — separate markdown-lite path

Quinn/assistant replies are stored and rendered outside the `contentJson` pipeline via
`AssistantAnswer` + `parseMarkdownLite` (paragraphs/lists/bold + `[n]` citations only).
Not a user-authoring gap, but it means AI replies can't carry the same formatting/images
as agent replies and render through a second, weaker code path.

### 3.8 Email — the deepest gap (Tier 5)

- **Inbound** (`conversation.email-inbound.ts`): reads `text/plain` only; **HTML bodies
  are un-parsed and HTML-only mail is dropped** (`{ status: 'empty' }`). MIME
  attachments and inline images are **never read** — silently discarded. No
  HTML→text/markdown/tiptap conversion exists (no `html-to-text`/`turndown`/server
  sanitizer in the domain).
- **Outbound** (`conversation.notify.ts` + `packages/email/.../conversation-message.tsx`):
  sends a **140-char truncated preview + CTA link**, never the rendered reply body.
  RFC 5322 threading is correct, but the payload is a stub.

## 4. Design decisions (LOCKED)

1. **Richness tier → "support-grade."** Reply/note composers enable **code blocks**
   (syntax-highlighted — logs, stack traces, config), **resizable images**, lists,
   blockquotes, links, mentions (agent side), embeds, emoji. **No** H1–H3 headings, **no**
   tables — matches Intercom/Zendesk/Front reply composers, keeps a chat feel.
2. **Unify onto the shared `RichTextEditor`.** Retire `ConversationRichComposer` /
   `ConversationNoteEditor` in favour of `RichTextEditor` + a new
   `CONVERSATION_EDITOR_FEATURES` preset (`{ codeBlocks: true, images: true,
   blockquotes: true, taskLists: false, tables: false, headings: false, embeds: true,
   quackbackEmbeds: true, emojiPicker: true, slashMenu: true, enterAsHardBreak: true }`;
   a note variant adds team mentions). Ends the drift; gives resizable images and code
   blocks for free. Preserve chat behaviours via flags/extensions: `enterAsHardBreak`
   (Enter-to-send), visitor image trust (`isTrustedAttachmentUrl`),
   no-mentions-for-visitors, `QuackbackEmbed`.
3. **Email fidelity is IN SCOPE** (Phase 4) — inbound HTML→`contentJson` ingestion +
   MIME attachment/inline-image extraction, and outbound full-body rendering (retire the
   140-char preview stub). This is the largest net-new build; sequenced after Phases 1–3.
4. **`content` stays the plaintext mirror / FTS source**, derived faithfully from
   `contentJson` server-side on write. No `search_vector` change needed.

## 5. Phased plan

### Phase 0 — Foundations (schema is ready; add server-side derivation)
- Confirm `conversation_messages` columns cover the target (they do).
- On write, derive/validate `content` from `contentJson` server-side (mirror posts) so
  FTS/transcript/API plaintext stays faithful even for API/MCP-authored rich messages.
- Extend the shared sanitize allowlist review to cover any node the chat preset newly
  enables (code block already allowlisted).

### Phase 1 — Close the plaintext holes (highest ROI, lowest risk)
- Portal ticket reply (`support.ticket.$ticketId.tsx`): replace `<Textarea>` with the
  conversation composer; send `contentJson` + `attachments` (backend already accepts —
  `replyToMyTicketFn` validates all three). **Frontend-only.**
- Agent new-ticket dialog + portal new-ticket dialog: rich composer + image upload for
  the description; stop storing `contentJson: null` on the opening message.
- New-conversation dialog: rich composer.
- Ship these before Phase 2's editor swap — they're independent and immediately visible.

### Phase 2 — Editor unification + feature parity
- Add `CONVERSATION_EDITOR_FEATURES` preset to `RichTextEditor`; migrate all composer
  consumers off `ConversationRichComposer`/`ConversationNoteEditor`.
- Enable code blocks + resizable images across replies **and** notes (notes gain an
  inline image node). Add agent-side mentions to replies.
- Preserve Enter-to-send, visitor image trust, embeds, emoji. Verify widget bundle size
  (full editor + lowlight is heavier — consider a lighter visitor preset / code-split).
- Node compatibility: `chatImage` (fixed) vs `resizableImage` — `generateContentHTML`
  already renders both; decide whether new inline images author as `resizableImage` and
  keep `chatImage` for back-compat parse.

### Phase 3 — Transport & serialization parity ("all layers")
- MCP `create_ticket`/`reply_to_ticket`/`add_ticket_note`: accept `contentJson` (or
  markdown → `markdownToTiptapJson`) + `attachments`; return `contentJsonToMarkdown` on
  reads (so image messages aren't lost, matching the post/changelog fix in #317).
- REST v1: stop stripping `contentJson`/`attachments` in `serializeTicketMessage`; add
  markdown derivation on read. Optionally add write endpoints (create/reply/note).
- Transcript export: render `contentJson` via a text extractor when `content` is blank
  so inline-image messages stop exporting as "(no text content)" (discrete attachments
  already print).
- Webhooks: add `ticket.replied` / `ticket.note_added` (or a `conversation.message`
  event) carrying `content` + `contentJson`-derived markdown + attachment refs.

### Phase 4 — Email fidelity (in scope; largest net-new build)
**Inbound** (`conversation.email-inbound.ts` / `.email-inbound.service.ts`, both the
Resend-webhook `parseInboundEmail` and IMAP `parseRawEmail`/`extractTextBody` paths):
- Read the HTML body part (not just `text/plain`); stop dropping HTML-only mail.
- Server-sanitize the HTML (add a server-side sanitizer — DOMPurify/JSDOM or
  `sanitize-html`; none exists in this domain today) against the same node/mark intent as
  `sanitizeTiptapContent`.
- Convert sanitized HTML → `contentJson`. Recommended: HTML→markdown (`turndown`) →
  `markdownToTiptapJson`, reusing the existing bridge and its allowlist, then run the
  result back through `sanitizeTiptapContent`. Keep `content` = the extracted plain-text
  reply (existing `extractReplyText` quote-trimming still applies).
- Parse MIME attachment parts (currently never read): inline images (`cid:`-referenced)
  → rehost to storage (reuse `uploadImageBuffer` / magic-byte sniff behind the SSRF
  guard) and rewrite into inline nodes; other files → `attachments[]`. Enforce the same
  size/count caps (`MAX_CONVERSATION_ATTACHMENTS`, 5 MB).
- Preserve `metadata.source = 'email'` + dedupe index; store `contentJson` alongside
  `content` instead of leaving it null.

**Outbound** (`conversation.notify.ts` + `packages/email/.../conversation-message.tsx`):
- Render the **full reply body** — `contentJson`→HTML (reuse `generateContentHTML`,
  re-sanitized for email) inside the React Email template — instead of the 140-char
  `previewOf` stub. Keep the CTA link and RFC 5322 threading (already correct).
- Inline images must resolve to absolute URLs (they already do — `contentJson` stores
  absolute `src`); ensure email clients can load them (public URL, not `/api/storage`
  redirect if the recipient is unauthenticated — verify `S3_PUBLIC_URL` path).

### Phase 5 — AI / Quinn convergence (optional)
- Have Quinn emit `contentJson` (or markdown → `markdownToTiptapJson`) so assistant
  replies render through `RichTextContent`, retiring `parseMarkdownLite`.

## 6. Cross-cutting risks

- **Sanitization:** all visitor/inbound `contentJson` must pass `sanitizeTiptapContent`
  (ticket path already does via `insertTicketMessage`); any new email-HTML path must
  sanitize before conversion.
- **Image portability:** `contentJson` embeds **absolute** image URLs; `rehost-images.ts`
  runs for posts/changelog/help-center but **not** conversations today. Visitor inline
  images are already same-origin-constrained (`isTrustedAttachmentUrl`); agent-pasted
  external images in replies are not rehosted → backup/restore/domain-migration
  portability gap. Decide whether to extend rehosting to conversation `contentJson`.
- **Widget bundle size:** the full `RichTextEditor` (+ lowlight) is heavier than the
  hand-rolled composer; the visitor widget may need a trimmed preset or lazy load.
- **Enter-to-send** behaviour and typing-indicator/send-gate logic (currently on
  `editor.getText()`) must survive the editor swap.
- **Requester reach:** requesters have no REST/MCP write path; rich API/MCP authoring is
  agent/integration only (portal UI is the requester's rich path).

## 7. Out of scope
- Two-column `content`/`contentJson` schema redesign (not needed — columns already exist).
- Comment image support (Tier 2 is a deliberate exclusion; unchanged).
- Macros/canned-response rich body (Tier 4 by choice; could be a follow-up).

## 8. Decisions locked / residual questions
**Locked (see §4):** support-grade richness; unify onto shared `RichTextEditor`; email in
scope (Phase 4).

**Residual (settle during implementation, not blocking):**
- **Inline image node:** author new conversation images as `resizableImage` (parity with
  posts) while keeping `chatImage` in the parse schema for back-compat? Or make
  `chatImage` itself resizable? `generateContentHTML` already renders both.
- **Widget bundle:** RESOLVED 2026-07-06 — visitor composer lazy-loads the editor
  (fetch deferred to composer mount, cached after). Measured: the editor chunk is
  ~362 kB gz, and the dominant weight is NOT lowlight grammars (trimmed anyway,
  no measurable change) but the FULL emoji dataset statically imported via
  `import { emojis } from '@tiptap/extension-emoji'` in rich-text-editor.tsx.
  BACKLOG: load the emoji suggestion dataset dynamically (picker-open time) —
  that, not grammar or chunk splitting, is the real lever.
- **REST write surface:** add `POST` create/reply/note endpoints for tickets, or keep
  writes MCP-only and just stop stripping rich fields on reads?
- **Rehosting conversations:** extend `rehost-images.ts` to conversation `contentJson`
  (agent-pasted external images) for backup/restore portability, or rely on the existing
  same-origin visitor constraint only?
- **HTML→contentJson path:** `turndown`→markdown→tiptap (reuses existing bridge) vs a
  direct HTML→ProseMirror parse (higher fidelity, more code). Start with the former.

---

## 9. Per-phase TDD task breakdown

Written so each task is executable by a smaller model without further exploration.
Every task is self-contained: exact files, exact functions, test-first steps, and
acceptance criteria. The main session orchestrates, verifies, and lands commits.

### 9.0 Conventions (apply to every task)

- **Visual ground truth:** the annotated interface mock at
  https://claude.ai/code/artifact/0041fcfe-9db8-4497-bcbd-6c63851ffab7 renders the
  target state for every ticket surface (agent workspace, slash menu, portal, new-ticket
  dialog) with numbered markers mapped to task IDs, the preset flag matrix, and the
  normative behavior-contract tables. Where a mock pixel and its tables disagree, the
  tables win; where this artifact and the spec disagree, flag it — don't guess.

- **TDD loop:** write the failing test first → run it and confirm it fails for the
  right reason → implement the minimal change → confirm green → refactor if needed.
- **Commands:** `bun run test <path>` (vitest, scope to the touched test file),
  `bun run typecheck`, `bun run lint`. Run all three before declaring a task done.
- **Test locations (existing, extend these):**
  - `apps/web/src/lib/server/domains/tickets/__tests__/` — e.g.
    `ticket-message.service.test.ts`, `requester.service.test.ts`, `ticket-webhooks.test.ts`
  - `apps/web/src/lib/server/domains/conversation/__tests__/` — e.g.
    `conversation-email-inbound.test.ts`, `conversation-email-imap.test.ts`,
    `conversation-export.test.ts`, `conversation-notify.test.ts`
  - `apps/web/src/lib/server/__tests__/markdown-tiptap.test.ts`, `sanitize-tiptap.test.ts`
  - `apps/web/src/components/ui/__tests__/rich-text-editor-extensions.test.ts`,
    `rich-text-editor.test.tsx`
- **Commit discipline:** one commit per task, conventional message
  (`feat(tickets): …` / `test(conversation): …`), no co-author trailers. Commit only
  when the task's tests + typecheck + lint pass.
- **No DB migrations anywhere in this effort** — `conversation_messages` already has all
  columns. If a task appears to need a migration, stop and escalate.
- **Sanitization invariant:** every write path for visitor/inbound `contentJson` must go
  through `sanitizeTiptapContent` (`apps/web/src/lib/server/sanitize-tiptap.ts`).
  `insertTicketMessage` already does this; never bypass it.
- **Model sizing:** each task is tagged **[S]** (mechanical, small model),
  **[M]** (moderate judgment, mid model), **[L]** (design judgment, large model or main
  session). Phase-boundary reviews are always run by the main session.
- **Phase boundary ritual:** after the last task of each phase — `/simplify` over the
  phase's diff, then `/codex:review`, fix findings, then a manual product pass in the
  dev app (`bun run dev`, login demo@example.com / password).

### Phase 0 — Foundations

**P0.1 [M] Server-side plaintext derivation from `contentJson`**
- *Goal:* `content` (FTS source, transcript, previews) stays faithful even when a
  caller sends rich `contentJson` with a blank/short `content`.
- *Files:* `apps/web/src/lib/server/markdown-tiptap.ts` (add export
  `tiptapJsonToText(json: TiptapContent): string` — walk `text` leaves, join blocks
  with `\n`, render `chatImage`/`image`/`resizableImage` as `[image]`, mentions as
  `@label`); `apps/web/src/lib/server/domains/tickets/ticket-message.service.ts`
  (in `insertTicketMessage`, when `input.content` is blank and `safeContentJson` is
  non-empty, derive `content = tiptapJsonToText(safeContentJson)` before
  `validateContent`); same derivation in the visitor/agent send paths in
  `apps/web/src/lib/server/domains/conversation/conversation.service.ts` (grep
  `.insert(conversationMessages)` — apply at the shared validation point, not all 8
  call sites; system/AI inserts are out of scope).
- *Test first:* `markdown-tiptap.test.ts` — unit-test `tiptapJsonToText` (paragraphs,
  lists, image→`[image]`, mention→`@name`, empty doc→`''`).
  `ticket-message.service.test.ts` — insert with `content: ''` + rich `contentJson`
  → stored `content` equals derived text (not `''`).
- *Done when:* both tests green; existing `richMessageFallbackLabel` behavior unchanged
  (image-only doc with no text still gets its fallback label).

**P0.2 [S] Sanitizer coverage for the support-grade node set**
- *Goal:* prove (or make) `sanitizeTiptapContent` preserve everything the new preset
  emits.
- *Files:* `apps/web/src/lib/server/sanitize-tiptap.ts` (only if a gap is found).
- *Test first:* extend `sanitize-tiptap.test.ts` with round-trip assertions:
  `codeBlock` keeps its `language` attr; `resizableImage` keeps `src`/`width`/
  `data-keep-ratio`; `mention` keeps `data-principal-id`/label; `quackbackEmbed`,
  `emoji`, `blockquote`, `link` mark survive. If an attr is stripped, add it to the
  allowlist with a comment.
- *Done when:* all round-trips pass.

### Phase 1 — Close the plaintext holes

**P1.1 [M] Server: `createTicket` accepts a rich opening message**
- *Goal:* the opening description can carry `contentJson` + `attachments`.
- *Files:* `apps/web/src/lib/server/domains/tickets/ticket.service.ts` (the create
  path that inserts the opening `conversation_messages` row from `description`) —
  extend its input with `descriptionJson?: TiptapContent | null` and
  `attachments?: ConversationAttachment[]`, pass through `insertTicketMessage`'s
  sanitize/validate path; `apps/web/src/lib/server/functions/tickets.ts` — extend the
  create validators (both agent + portal create fns, near the existing
  `ticketAttachmentSchema` at ~line 341) with `descriptionJson`/`attachments`;
  `apps/web/src/lib/server/domains/tickets/requester.service.ts` (`createMyTicket`
  ~line 95, plumb the two new fields).
- *Test first:* `ticket.service.test.ts` + `requester.service.test.ts` — create with
  `descriptionJson` → opening message row has sanitized `contentJson` and derived
  `content`; create with hostile contentJson (script-bearing attrs) → sanitized.
- *Done when:* green; creating without the new fields behaves exactly as before.

**P1.2 [S] Portal ticket reply → rich composer (frontend only)**
- *Goal:* requesters compose rich replies; backend already accepts everything.
- *Files:* `apps/web/src/routes/_portal/support.ticket.$ticketId.tsx` — replace the
  `<Textarea>` (~line 158) with `ConversationRichComposer` (import from
  `@/components/admin/conversation/conversation-rich-composer` — interim; Phase 2
  swaps it again), mirroring its usage in
  `apps/web/src/components/shared/conversation/visitor-conversation-thread.tsx`
  (image upload via `usePortalImageUpload` → `/api/portal/upload`). Change the
  mutation (~line 83) to send `{ ticketId, content, contentJson, attachments }`.
- *Test first:* extend `requester.service.test.ts` — `replyToMyTicket` with
  contentJson+attachments persists both (proves the wire shape end-to-end).
- *Done when:* green + manual check: portal reply with bold text + pasted image renders
  in both the portal thread and the agent `TicketThread`.

**P1.3 [S] Agent new-ticket dialog → rich description**
- *Files:* `apps/web/src/components/admin/tickets/new-ticket-dialog.tsx` — replace the
  description `<Textarea>` (~line 128) with `ConversationRichComposer`
  (`usePostImageUpload`-style admin upload via `/api/upload/image`, prefix
  `chat-images`); submit `descriptionJson` + `attachments` via the P1.1 create fn.
- *Test:* covered by P1.1 server tests; manual acceptance in the admin app.
- *Done when:* new agent-created ticket's opening message has `contentJson` populated.

**P1.4 [S] Portal new-ticket dialog → rich description**
- *Files:* `apps/web/src/components/portal/new-portal-ticket-dialog.tsx` (~line 93),
  same pattern as P1.3 but with `usePortalImageUpload`.
- *Done when:* portal-created ticket's opening message has `contentJson` populated.

**P1.5 [S] New-conversation dialog → rich composer**
- *Files:* `apps/web/src/components/admin/conversation/new-conversation-dialog.tsx` —
  swap `<Textarea>` for `ConversationRichComposer`; confirm the send path accepts
  `contentJson` (it's the standard conversation send in `conversation.service.ts`).
- *Done when:* outbound proactive message stores `contentJson`.

*Phase 1 boundary:* `/simplify` → `/codex:review` → manual pass (create + reply on a
ticket from both sides with images).

### Phase 2 — Editor unification

**P2.1 [M] Add `mentions` feature flag to `buildExtensions`**
- *Goal:* mentions become opt-out (they're currently always registered) so the visitor
  preset can disable them.
- *Files:* `apps/web/src/components/ui/rich-text-editor.tsx` — add
  `mentions?: boolean` (default `true`) to `EditorFeatures`; register
  `MentionExtension` only when enabled.
- *Test first:* `rich-text-editor-extensions.test.ts` — `buildExtensions({mentions:
  false})` excludes the mention extension; default includes it; existing preset
  behaviors unchanged.

**P2.2 [M] Add `submitOnEnter` to `RichTextEditor`**
- *Goal:* chat semantics — Enter sends, Shift+Enter breaks (distinct from the existing
  `enterAsHardBreak`, which only soft-breaks).
- *Files:* `rich-text-editor.tsx` — new prop `onSubmit?: () => void`; when set, add a
  keyboard-shortcut extension: Enter → call `onSubmit` (unless the slash menu /
  mention/emoji suggestion popup is active — reuse `hasActiveSuggestion(editor)`),
  Shift+Enter → hard break.
- *Test first:* `rich-text-editor-extensions.test.ts` — with `onSubmit`, Enter
  triggers the callback and does not insert a paragraph; Shift+Enter inserts a hard
  break; Enter with an active suggestion does not submit.

**P2.3 [S] Define the presets**
- *Files:* new `apps/web/src/components/conversation/conversation-editor-features.ts`
  exporting `CONVERSATION_EDITOR_FEATURES` (§4.2 values), `CONVERSATION_NOTE_FEATURES`
  (same + `mentions: true`), `VISITOR_CONVERSATION_FEATURES` (same as reply preset but
  `mentions: false`). Mirror the shape of
  `apps/web/src/components/public/comment-editor-features.ts`.
- *Test:* trivial snapshot of the three objects in a colocated test (guards accidental
  flag drift, same rationale as locale-parity).

**P2.4 [L] Swap the agent reply composer**
- *Files:* `apps/web/src/components/conversation/agent-conversation-thread.tsx`
  (reply mode ~line 854) — replace `ConversationRichComposer` with `RichTextEditor` +
  `CONVERSATION_EDITOR_FEATURES`, `onSubmit` wired to send, `onImageUpload` to the
  admin upload (prefix `chat-images`), send-gate/typing-indicator moved from
  `editor.getText()` to the `onChange(json, html, markdown)` callback (derive text
  from the editor instance or add a text arg — keep the existing "non-empty" gate
  semantics exactly).
- *Test first:* server behavior is already covered; add/extend a component test in
  `rich-text-editor.test.tsx` only if the send-gate logic moves into the editor.
  Otherwise this task's gate is manual: send, Enter-to-send, Shift+Enter, image paste,
  emoji, embed paste, draft-preservation on mode toggle.
- *Done when:* agent replies author code blocks + resizable images; Enter still sends.

**P2.5 [S] Swap the ticket reply composer** — `apps/web/src/components/admin/tickets/
ticket-thread.tsx`, identical mechanics to P2.4 (it shares the pattern).

**P2.6 [M] Swap the visitor composer (widget + portal)**
- *Files:* `apps/web/src/components/shared/conversation/visitor-conversation-thread.tsx`
  → `RichTextEditor` + `VISITOR_CONVERSATION_FEATURES`; image upload stays on the
  widget/portal endpoints. **Lazy-load** the editor (dynamic import) in the widget
  bundle and record before/after bundle size in the PR description; if the delta is
  unacceptable (>~150 kB gz), escalate rather than ship.
- *Done when:* widget visitor can send code blocks/images; no mention UI appears;
  bundle delta recorded.

**P2.7 [M] Swap the note editor**
- *Files:* `agent-conversation-thread.tsx` note mode (~line 864) + `ticket-thread.tsx`
  → `RichTextEditor` + `CONVERSATION_NOTE_FEATURES`. Notes gain inline images
  (previously tray-only); keep the attachment tray.
- *Done when:* a note can carry an inline image + @mention; mention notifications
  still fire (existing note-mention path unchanged — it reads the mention nodes from
  contentJson).

**P2.8 [S] Retire the hand-rolled composers**
- *Files:* delete `conversation-rich-composer.tsx` and
  `conversation-note-editor.tsx` once nothing imports them (grep first). **Keep**
  `ConversationImage` (`chatImage` node, `apps/web/src/components/ui/
  conversation-image-node.tsx`) registered unconditionally in `buildExtensions`
  (like `ResizableImage`) so legacy messages still parse/render. New images author as
  `resizableImage`.
- *Test first:* `rich-text-editor-extensions.test.ts` — `buildExtensions({})` includes
  the `chatImage` node; `generateContentHTML` on a legacy chatImage doc still renders
  an `<img>` (extend `rich-text-editor.test.tsx`).

*Phase 2 boundary:* `/simplify` → `/codex:review` → full manual matrix: agent reply,
agent note, ticket reply, ticket note, widget visitor, portal visitor, portal ticket
reply (P1.2 surface now also swaps to the unified editor — one-line preset change).

### Phase 3 — Transport & serialization parity

**P3.1 [M] REST: stop stripping rich fields**
- *Files:* `apps/web/src/routes/api/v1/tickets/-serialize.ts`
  (`serializeTicketMessage`) — add `contentJson`, `attachments`; derive `content` via
  `contentJsonToMarkdown(m.contentJson, m.content)`;
  `apps/web/src/lib/server/domains/api/schemas/tickets.ts` — extend the OpenAPI
  message schema to match.
- *Test first:* new `apps/web/src/routes/api/v1/tickets/__tests__/serialize.test.ts` —
  message with image-bearing contentJson serializes markdown containing `![](…)` and
  echoes attachments; plain message unchanged verbatim.

**P3.2 [M] MCP: markdown-in on write tools**
- *Files:* `apps/web/src/lib/server/mcp/tools/tickets.ts` — `create_ticket`
  (description, ~line 185), `reply_to_ticket` (~line 229), `add_ticket_note`
  (~line 256): treat `content`/`description` as markdown; convert via
  `markdownToTiptapJson` → `sanitizeTiptapContent` → pass as `contentJson` alongside
  the raw text (mirror how posts MCP does it — see `mcp/tools/posts.ts`).
- *Test first:* extend the MCP tickets test (or create
  `mcp/tools/__tests__/tickets.test.ts` matching siblings): reply with
  `**bold** and \n- list` stores structured `contentJson`; plain single-line content
  stores a minimal doc; hostile markdown (raw HTML/script) is neutralized.

**P3.3 [S] MCP: markdown-out on read tools**
- *Files:* `mcp/tools/tickets.ts` `get_ticket` (~line 161) + `list_tickets` message
  rendering — return `contentJsonToMarkdown(m.contentJson, m.content)` and an
  `attachments` summary (name + url).
- *Test first:* image-only message no longer reads as empty; includes `![](…)`.

**P3.4 [S] Transcript export: stop losing inline images**
- *Files:* `apps/web/src/lib/server/domains/conversation/conversation.transcript.ts`
  (~line 63) — when `m.content` is blank but `contentJson` exists, render
  `tiptapJsonToText(m.contentJson)` (P0.1 helper; images → `[image] <src>`); discrete
  attachments already print (~line 65) — leave that.
- *Test first:* extend `conversation-transcript.test.ts` (NOT `conversation-export.test.ts`,
  which covers the unrelated NDJSON bulk export) — image-only message exports an
  `[image] https://…` line, never `(no text content)`.

**P3.5 [L] Webhooks: `ticket.replied` + `ticket.note_added`**
- *Files:* `apps/web/src/lib/server/events/types.ts` (event data types),
  `apps/web/src/lib/server/events/dispatch.ts` (add `dispatchTicketReplied`,
  `dispatchTicketNoteAdded` next to the three existing dispatchers ~line 427+),
  `apps/web/src/lib/server/domains/tickets/ticket.webhooks.ts` (bridge fns, same
  `safe()` fire-and-forget pattern), call sites in `ticket-message.service.ts`
  (`replyToTicket` / note path, after commit). Payload: ticket ref, author, `content`
  (markdown via `contentJsonToMarkdown`), attachment refs. **Never include internal
  note content in any event a non-team consumer can subscribe to** — mirror how
  existing events scope data; if the event bus has no team-only channel, the
  note event carries a ref + redacted preview only (escalate if ambiguous).
- *Test first:* extend `ticket-webhooks.test.ts` — reply dispatches `ticket.replied`
  with markdown content; note dispatches `ticket.note_added`; dispatch failure does
  not fail the write (existing `safe()` semantics).

*Phase 3 boundary:* `/simplify` → `/codex:review` → regenerate/verify OpenAPI output
(`publish` pipeline gotcha in release_process memory does not apply here, but confirm
`bun run build` passes).

### Phase 4 — Email fidelity

**P4.1 [M] Inbound: read HTML bodies (both transports)**
- *Files:* `apps/web/src/lib/server/domains/conversation/conversation.email-inbound.ts`
  — `parseInboundEmail` (webhook): also read `d.html`;
  `parseRawEmail`/`extractTextBody` (IMAP): extract the first `text/html` part when
  no `text/plain` exists (and carry both when both exist). Return shape grows a
  `html?: string` field; an HTML-only email is no longer `{ status: 'empty' }`.
- *Test first:* `conversation-email-inbound.test.ts` + `conversation-email-imap.test.ts`
  — HTML-only fixture ingests instead of dropping; multipart keeps preferring
  text/plain for the `text` field but now also returns `html`.

**P4.2 [M] Server HTML sanitizer**
- *Files:* add `sanitize-html` to `apps/web/package.json` (pin exact — see the zod
  lockfile gotcha); new `apps/web/src/lib/server/content/sanitize-email-html.ts`
  exporting `sanitizeEmailHtml(html: string): string` — allowlist aligned with the
  tiptap node set (p, br, a[href], b/strong, i/em, u, s, code, pre, blockquote,
  ul/ol/li, img[src]); strip style/script/tracking pixels (images with 1x1 dims or
  known tracker hosts → drop).
- *Test first:* new colocated test — script/style stripped, `javascript:` hrefs
  removed, benign formatting preserved, tracking pixel removed.

**P4.3 [L] Inbound: HTML → `contentJson`**
- *Files:* add `turndown` (pin exact); new
  `apps/web/src/lib/server/content/email-html-to-content.ts` exporting
  `emailHtmlToContent(html): { text: string; contentJson: TiptapContent | null }` —
  pipeline: `sanitizeEmailHtml` → turndown → `markdownToTiptapJson` →
  `sanitizeTiptapContent`; `text` = markdown stripped to plaintext (reuse
  `tiptapJsonToText`). Trim quoted history *before* conversion: extend the existing
  `extractReplyText` heuristics with HTML-level equivalents (`<blockquote>` chains,
  `gmail_quote`/`OutlookMessageHeader` class markers). Wire into
  `conversation.email-inbound.service.ts`'s `ingestParsedEmail`: store `contentJson`
  alongside `content` (which keeps the quote-trimmed plain text).
- *Test first:* fixtures — Gmail reply (quoted history dropped, bold/list preserved
  in contentJson), Outlook reply, plaintext-only mail (contentJson null, unchanged
  behavior), hostile HTML (sanitized).

**P4.4 [L] Inbound: MIME attachments + inline images**
- *Files:* `conversation.email-imap.ts` (parse attachment parts: filename,
  content-type, content-id, base64 body) and the webhook path (Resend attachment
  fields); new handling in `ingestParsedEmail`: rehost each part via
  `uploadImageBuffer` (`apps/web/src/lib/server/storage/s3.ts`, magic-byte sniff,
  prefix `chat-images`), `cid:`-referenced images → rewrite the corresponding
  `contentJson` image node src to the rehosted URL; non-inline files →
  `attachments[]` (respect `MAX_CONVERSATION_ATTACHMENTS` = 10, 5 MB/file — drop
  excess with a log line, never fail the ingest).
- *Test first:* fixture with one inline cid image + one PDF: image node src becomes a
  storage URL, PDF appears in `attachments`; oversized part dropped with ingest still
  succeeding; a hostile part with mismatched magic bytes is rejected.

**P4.5 [L] Outbound: full reply body**
- *Files:* `apps/web/src/lib/server/domains/conversation/conversation.notify.ts` —
  render the reply's `contentJson` to HTML at send time and pass it to the template
  as a new prop (keep `previewOf` for the subject/preheader only). Rendering: extract
  `generateContentHTML` from `rich-text-editor.tsx` into a shared module importable
  server-side without pulling React/tiptap-react (it is a pure JSON→string walker —
  move it to e.g. `apps/web/src/lib/shared/content-html.ts` and re-export from the
  editor file to avoid touching all render call sites);
  `packages/email/src/templates/conversation-message.tsx` — render the HTML body
  (dangerouslySetInnerHTML inside the quote block) instead of the truncated preview;
  fall back to the preview when no contentJson/plain content is short.
- *Test first:* `conversation-notify.test.ts` — email payload contains the full
  rendered body (bold survives, image `<img src>` absolute); plaintext-only message
  falls back to current behavior. Unit-test the extracted `generateContentHTML`
  module import from a server context (no `window`).
- *Gotcha:* image URLs must be publicly resolvable by mail clients — assert the src
  origin is `S3_PUBLIC_URL` when configured; if only the `/api/storage/` redirect is
  available, note it in the PR (recipient fetches anonymously; that route must allow
  unauthenticated GET or images break — verify, escalate if it doesn't).

**P4.6 [S] Outbound threading regression guard**
- *Test only:* extend `conversation-notify.test.ts` to pin `Message-ID`/
  `In-Reply-To`/`References` behavior across the P4.5 change (they must be
  byte-identical to before).

*Phase 4 boundary:* `/simplify` → `/codex:review` → live IMAP smoke test against a
real mailbox (manual; send an HTML email with an inline image + attachment).

### Phase 5 — Quinn convergence (optional, unscheduled)

**P5.1 [M]** Quinn replies emit markdown → `markdownToTiptapJson` → store
`contentJson`; `message-bubble.tsx` drops the `isAssistant` special case in favor of
`RichTextContent`; keep `[n]` citation-dot rendering (port the citation overlay into
the rich render path). Retire `parseMarkdownLite` once no consumer remains.

### 9.1 Dependency graph

```
P0.1 ──┬── P1.1 ── P1.3, P1.4          P2.1, P2.2 ── P2.3 ──┬── P2.4 ── P2.5
       │                                                    ├── P2.6
       └── P3.4                                             └── P2.7 ── P2.8
P0.2 ── (gates all contentJson-writing tasks)
P1.2, P1.5 — independent after P0.x
P3.1, P3.2, P3.3, P3.5 — independent after P0.1
P4.1 ── P4.2 ── P4.3 ── P4.4          P4.5 ── P4.6
```
Parallelizable lanes for subagent dispatch: (A) P1 UI tasks, (B) P3 transport tasks,
(C) P4 email tasks — each lane sequential internally, lanes independent after Phase 0.
