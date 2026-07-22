-- Reverse-lookup index for GitHub inbound issue sync: maps a webhook's
-- issue.user.id back to the linked Quackback user via
-- account (provider_id, account_id). Hand-written because drizzle-kit generate
-- cannot run against this repo's meta (duplicate snapshot ids at 0050-0052).
CREATE INDEX IF NOT EXISTS "account_provider_account_idx" ON "account" USING btree ("provider_id","account_id");
