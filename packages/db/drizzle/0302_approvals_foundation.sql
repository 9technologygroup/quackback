-- @contract: safe-after 0.14.1 (the parent check is widened to also allow a request with no parent; every existing writer still sets exactly one parent)
-- Approvals: a pending action records who asked, for whom, how risky it is,
-- the exact content a decision binds to, and how and why it was decided.
--
-- Expand-only and replay-safe. Every column is ADD COLUMN IF NOT EXISTS and
-- nullable with no default, so a version without them keeps inserting rows
-- that read as before. Foreign keys are declared inline with their names
-- spelled out, because a bare ADD CONSTRAINT errors on a second run.
--
-- No vocabulary column carries a CHECK. Widening one later would need a
-- DROP/ADD pair; the application validates every value it writes, and a row
-- written before these columns existed is classified from its content when it
-- is read.

-- The principal that filed the request: an API key's service principal, the
-- AI assistant, or a person who asked in the app. Never the decider.
ALTER TABLE "assistant_pending_actions" ADD COLUMN IF NOT EXISTS "requested_by_id" uuid CONSTRAINT "assistant_pending_actions_requested_by_id_principal_id_fk" REFERENCES "principal"("id") ON DELETE set null;
--> statement-breakpoint
-- The person whose authority the request borrows: a key's creator, or the
-- teammate an assistant works for. Like any qualified person, they may decide.
ALTER TABLE "assistant_pending_actions" ADD COLUMN IF NOT EXISTS "on_behalf_of_principal_id" uuid CONSTRAINT "assistant_pending_actions_on_behalf_of_fk" REFERENCES "principal"("id") ON DELETE set null;
--> statement-breakpoint
-- How the request arrived: ui, api, mcp, assistant or workflow.
ALTER TABLE "assistant_pending_actions" ADD COLUMN IF NOT EXISTS "requested_via" text;
--> statement-breakpoint
-- The credential that filed it (an API key id or an OAuth client id), and the
-- name its client goes by. A decision can never arrive through it.
ALTER TABLE "assistant_pending_actions" ADD COLUMN IF NOT EXISTS "credential_id" text;
--> statement-breakpoint
ALTER TABLE "assistant_pending_actions" ADD COLUMN IF NOT EXISTS "client_name" text;
--> statement-breakpoint
-- low, medium, high or critical, set by the server for the operation.
ALTER TABLE "assistant_pending_actions" ADD COLUMN IF NOT EXISTS "risk" text;
--> statement-breakpoint
-- The digest of the exact operation proposed. A decision names the digest it
-- approved, and a request whose content no longer matches is refused.
ALTER TABLE "assistant_pending_actions" ADD COLUMN IF NOT EXISTS "args_digest" text;
--> statement-breakpoint
-- The digest of the input contract the request was made against, for tools
-- whose contract lives outside this repository.
ALTER TABLE "assistant_pending_actions" ADD COLUMN IF NOT EXISTS "contract_digest" text;
--> statement-breakpoint
-- How and why it was decided: app, email, assistant or slack, and the
-- reason a person gave.
ALTER TABLE "assistant_pending_actions" ADD COLUMN IF NOT EXISTS "decided_via" text;
--> statement-breakpoint
ALTER TABLE "assistant_pending_actions" ADD COLUMN IF NOT EXISTS "decision_reason" text;
--> statement-breakpoint
-- Execution is its own dimension, distinct from the decision: an approved
-- action may still be queued, running, or finished.
ALTER TABLE "assistant_pending_actions" ADD COLUMN IF NOT EXISTS "execution_state" text;
--> statement-breakpoint
ALTER TABLE "assistant_pending_actions" ADD COLUMN IF NOT EXISTS "execution_job_id" text;
--> statement-breakpoint
ALTER TABLE "assistant_pending_actions" ADD COLUMN IF NOT EXISTS "execution_error" text;
--> statement-breakpoint
-- Why a request stopped being decidable without anybody deciding it, such as
-- `superseded:merged` for one replaced by a combined request.
ALTER TABLE "assistant_pending_actions" ADD COLUMN IF NOT EXISTS "disposition" text;
--> statement-breakpoint
-- @replay: guarded-by the parent check already allowing no parent; the replacement is skipped after its first application
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'assistant_pending_actions'::regclass AND conname = 'assistant_pending_actions_parent_check' AND pg_get_constraintdef(oid) LIKE '%<= 1%') THEN
    ALTER TABLE assistant_pending_actions DROP CONSTRAINT IF EXISTS assistant_pending_actions_parent_check;
    ALTER TABLE assistant_pending_actions ADD CONSTRAINT assistant_pending_actions_parent_check CHECK (num_nonnulls(conversation_id, ticket_id, workspace_thread_key) <= 1);
  END IF;
END $$;
--> statement-breakpoint
-- One unread approval bell per person: concurrent requests then count up the
-- same row through an upsert instead of adding a second one. The type is new
-- with this migration, so no existing rows can collide.
--
-- Built here rather than concurrently after the migration, because the upsert
-- needs it from the first approval bell. The build scans the whole table under
-- a SHARE lock (new notifications wait; reads do not), but the partial index
-- holds no rows yet, so the scan is all it costs. Measured on Postgres 18 with
-- 1,000,000 notifications (423 MB with their indexes, 2,000 recipients, 90%
-- read), inside a transaction as the migrator runs it, on a busy machine
-- (load average 15) with the table cached: 108 to 121 ms for the build,
-- under 0.5 s with the commit. A table read cold from disk adds the time to
-- read it once.
CREATE UNIQUE INDEX IF NOT EXISTS "in_app_notifications_unread_approval_idx" ON "in_app_notifications" ("principal_id") WHERE "type" = 'approval_requested' AND "read_at" IS NULL AND "archived_at" IS NULL;
--> statement-breakpoint
-- The requests still waiting for a decision, newest first: what the approvals
-- queue and its count read.
CREATE INDEX IF NOT EXISTS "assistant_pending_actions_waiting_idx" ON "assistant_pending_actions" ("proposed_at" DESC) WHERE "status" = 'proposed';
--> statement-breakpoint
-- The requests already decided, most recent first: what the approvals
-- queue's Decided tab reads.
CREATE INDEX IF NOT EXISTS "assistant_pending_actions_decided_idx" ON "assistant_pending_actions" ("decided_at" DESC) WHERE "decided_at" IS NOT NULL;
