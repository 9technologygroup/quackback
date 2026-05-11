-- Admin authentication settings: schema groundwork.
--
-- Phase A of the admin-auth-settings rollout. Two new columns plus a
-- one-time backfill so existing SSO admins don't have to wait 7 days
-- to flip enforcement after deploy.
--
-- principal.last_sso_sign_in_at:
--   Read by the SSO-enforcement bootstrap guard. Null = never signed in
--   via SSO. Written by the /oauth2/callback/:providerId hooks.after
--   middleware on every successful SSO callback that creates a session.
--
-- settings.auth_config_version:
--   Monotonic version number bumped on every auth-instance-affecting
--   write. Pods compare cached instance version against this on each
--   request and call resetAuth() on mismatch (defense-in-depth backstop
--   for the Redis pub/sub `auth:config-invalidate` channel). Mutated
--   only via atomic `auth_config_version + 1` to avoid lost updates.
--
-- Backfill: any principal whose user has at least one SSO account row
-- gets `now()` so the bootstrap guard's 7-day window passes for them
-- on first deploy. Operators who want stricter behavior can clear the
-- backfill manually.

ALTER TABLE "principal" ADD COLUMN "last_sso_sign_in_at" timestamp with time zone;

ALTER TABLE "settings"
  ADD COLUMN "auth_config_version" integer NOT NULL DEFAULT 0;

UPDATE "principal"
   SET "last_sso_sign_in_at" = now()
 WHERE "user_id" IN (
   SELECT "user_id" FROM "account" WHERE "provider_id" = 'sso'
 );
