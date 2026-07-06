-- The Copilot usage report (analytics/copilot-usage.ts) scans
-- assistant_pending_actions by proposed_at alone (no status predicate — the
-- proposed/approved/rejected/expired split is a set of FILTER'd counts inside
-- one aggregate), and assistant_tool_calls's existing (status, created_at)
-- index doesn't serve quinn-tools.ts's per-tool breakdown, which filters ONLY
-- on created_at; the same plain index also backs the new 180-day retention
-- sweep's DELETE ... WHERE created_at < cutoff.
CREATE INDEX "assistant_pending_actions_proposed_at_idx" ON "assistant_pending_actions" USING btree ("proposed_at");
--> statement-breakpoint
CREATE INDEX "assistant_tool_calls_created_at_idx" ON "assistant_tool_calls" USING btree ("created_at");
