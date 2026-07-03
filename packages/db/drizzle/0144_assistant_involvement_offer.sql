-- Two timestamps on the assistant involvement record (Quinn messenger wiring,
-- SUPPORT-PLATFORM-SPEC §4.7):
--   escalation_offered_at    : stamped when Quinn makes its single escalation
--                              OFFER. Its presence is the "already offered" flag
--                              the engine reads, so a repeat escalation goes
--                              straight to hand-off (never offered twice).
--   last_assistant_answer_at : the time of Quinn's last substantive answer. The
--                              inactivity clock the stale-involvement sweep reads
--                              to assume a resolution once the customer goes quiet.
ALTER TABLE "assistant_involvements" ADD COLUMN "escalation_offered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assistant_involvements" ADD COLUMN "last_assistant_answer_at" timestamp with time zone;--> statement-breakpoint
-- Partial index for the stale-involvement sweep: it scans active involvements by
-- last-answer time, so only active rows need to be indexed.
CREATE INDEX IF NOT EXISTS assistant_involvements_active_answer_idx ON assistant_involvements (last_assistant_answer_at) WHERE status = 'active';
