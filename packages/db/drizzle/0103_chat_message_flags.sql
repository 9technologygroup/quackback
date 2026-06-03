-- Team-wide "flag" on a chat message — a shared triage marker visible to every
-- agent. chat_message_id is the PRIMARY KEY, so there is exactly one flag state
-- per message: flagging is idempotent and team-wide, not per-agent. The message
-- FK cascades; flagged_by_principal_id is SET NULL on principal deletion so the
-- flag survives as an anonymous team signal rather than vanishing. Agent-only —
-- never exposed to the visitor (loaded on the agent path, broadcast inbox-only).
CREATE TABLE "chat_message_flags" (
  "chat_message_id" uuid PRIMARY KEY REFERENCES "chat_messages"("id") ON DELETE CASCADE,
  "flagged_by_principal_id" uuid REFERENCES "principal"("id") ON DELETE SET NULL,
  "flagged_at" timestamptz NOT NULL DEFAULT now()
);
