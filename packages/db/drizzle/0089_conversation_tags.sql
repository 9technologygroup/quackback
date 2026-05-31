-- Conversation labels. Reuses the shared "tags" table so the chat inbox and
-- feedback posts draw from one tag vocabulary. Agent-only; never exposed to the
-- visitor. Both FKs cascade so deleting a tag or a conversation cleans up here.

CREATE TABLE "conversation_tags" (
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "tag_id" uuid NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "conversation_tags_pk"
  ON "conversation_tags" ("conversation_id", "tag_id");

CREATE INDEX "conversation_tags_conversation_id_idx"
  ON "conversation_tags" ("conversation_id");

CREATE INDEX "conversation_tags_tag_id_idx"
  ON "conversation_tags" ("tag_id");
