-- Agent-only internal notes on a conversation. Internal messages are never
-- sent to or visible to the visitor (filtered from visitor read paths + unread
-- counts, and published only to the agent inbox channel).

ALTER TABLE "chat_messages" ADD COLUMN "is_internal" boolean NOT NULL DEFAULT false;
