-- Better-Auth twoFactor plugin schema.
--
-- Adds the per-user `two_factor_enabled` flag (default false) and the
-- `two_factor` table that holds the TOTP shared secret + recovery
-- backup codes. Secret and backup codes are symmetric-encrypted by
-- Better-Auth at write time using `secret`; we never store plaintext.
--
-- `verified` defaults true because Better-Auth flips it false only
-- between `/two-factor/enable` and the matching `/two-factor/verify-
-- totp` call. Rows that hang around verified=false are abandoned
-- enrolments and safe to garbage-collect, but no cleanup job is wired
-- yet — the user-facing enable flow re-issues a fresh row each call.
--
-- Auth-instance-affecting writes (none here yet, but the plugin add
-- itself rebuilds Better-Auth at boot) don't need an
-- auth_config_version bump because the plugin set is fixed at module
-- load time and not driven by DB state.

ALTER TABLE "user" ADD COLUMN "two_factor_enabled" boolean NOT NULL DEFAULT false;

CREATE TABLE "two_factor" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "secret" text NOT NULL,
  "backup_codes" text NOT NULL,
  "verified" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "two_factor_user_id_idx" ON "two_factor" ("user_id");
