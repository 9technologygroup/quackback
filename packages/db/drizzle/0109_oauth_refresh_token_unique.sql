-- better-auth 1.6.11+ expects a unique constraint on oauth_refresh_token.token:
-- refresh-token rotation now uses compare-and-swap on the parent row, with the
-- constraint as defense-in-depth against concurrent rotations forking a token
-- family. Tokens are stored as SHA-256 hashes of 32-char random strings, so
-- pre-existing duplicates are not a realistic concern.
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_token_unique" UNIQUE("token");
