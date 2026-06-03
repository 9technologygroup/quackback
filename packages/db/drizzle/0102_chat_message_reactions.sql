-- Emoji reactions on chat messages — an agent-only signal that mirrors the
-- comment_reactions table. One row per (message, principal, emoji); the unique
-- index makes a repeat reaction idempotent (INSERT ... ON CONFLICT DO NOTHING).
-- Both foreign keys cascade, so deleting a message or a principal removes their
-- reaction rows. These rows are NEVER exposed to the visitor — they are loaded
-- only on the agent enrichment path and broadcast only on the inbox channel.
CREATE TABLE "chat_message_reactions" (
  "id" uuid PRIMARY KEY,
  "chat_message_id" uuid NOT NULL REFERENCES "chat_messages"("id") ON DELETE CASCADE,
  "principal_id" uuid NOT NULL REFERENCES "principal"("id") ON DELETE CASCADE,
  "emoji" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "chat_message_reactions_message_idx"
  ON "chat_message_reactions" ("chat_message_id");

CREATE INDEX "chat_message_reactions_principal_idx"
  ON "chat_message_reactions" ("principal_id");

CREATE UNIQUE INDEX "chat_message_reactions_unique_idx"
  ON "chat_message_reactions" ("chat_message_id", "principal_id", "emoji");
