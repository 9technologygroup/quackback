-- Family lookups on oauth_refresh_token previously seq-scanned: the
-- grace-heal hook (auth/refresh-grace.ts) resolves a rotation successor by
-- (client_id, user_id, created_at), and better-auth's reuse-detection
-- family revocation lists rows by (client_id, user_id). One composite
-- index serves both.
CREATE INDEX "oauth_refresh_token_client_user_created_idx" ON "oauth_refresh_token" USING btree ("client_id", "user_id", "created_at");
