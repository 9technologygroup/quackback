-- @contract: additive
-- Who made a change, through what, and for whom. Each audit row can now say
-- which channel carried the change (ui, api, mcp, assistant, workflow or
-- system), which credential made it (an API key or an OAuth client, by id and
-- by the name it carried at the time) and the person that credential acts
-- for: the OAuth user, or the teammate who created the API key.
--
-- Every column is nullable with no default. Rows written before this change
-- stay null, because nothing about how they were made is known. No index:
-- the feed still reads by time and event type, and every index here is paid
-- for on each audited write.
--
-- on_behalf_of_principal_id carries no foreign key, like the denormalised
-- actor columns: an audit row outlives the people it names, and removing a
-- principal must never have to scan or rewrite the audit log.
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "channel" text;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "credential_kind" text;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "credential_id" text;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "client_name" text;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "on_behalf_of_principal_id" uuid;
