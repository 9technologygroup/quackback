-- Move verified SSO domains from JSON sub-object to a dedicated table.
--
-- Today: `settings.auth_config::jsonb -> 'ssoOidc' -> 'domain'` is a
--   single nullable object — one verified domain per workspace.
-- Now:   `sso_verified_domain` table holds 0..N domain rows. Each row
--   carries its own `enforced` flag — the workspace-wide
--   `ssoOidc.enforced` toggle is removed.
--
-- The "block all team non-SSO sign-ins regardless of email domain"
-- capability that the global `enforced=true` flag implemented is
-- intentionally dropped: it was incoherent (forced contractors at
-- unverified domains into magic-link-only, when they have no SSO
-- identity to use anyway). Workspaces that want it back can verify
-- every domain and turn on per-row enforce, or wait for a future
-- "team members must be at a verified domain" feature.
--
-- `id` is a native PostgreSQL `uuid` — Drizzle's typeid column type
-- maps it to a `domain_*` typeid string at the application layer.
-- Backfill uses `gen_random_uuid()` directly; the prefix is added
-- only when the value crosses the ORM boundary.
--
-- The trailing `auth_config_version` bump invalidates cached Better-
-- Auth instances across pods on the next request.

CREATE TABLE "sso_verified_domain" (
  "id" uuid PRIMARY KEY,
  "name" text NOT NULL,
  "verification_token" text NOT NULL,
  "verified_at" timestamptz,
  "enforced" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "sso_verified_domain_name_unique" ON "sso_verified_domain" ("name");

-- Backfill any existing authConfig.ssoOidc.domain into the new table.
-- Stamp `enforced=true` iff the workspace had the global enforcement
-- flag on. With single-tenant settings this is at most one row.
INSERT INTO "sso_verified_domain" (
  "id", "name", "verification_token", "verified_at", "enforced", "created_at"
)
SELECT
  gen_random_uuid(),
  (auth_config::jsonb -> 'ssoOidc' -> 'domain' ->> 'name'),
  (auth_config::jsonb -> 'ssoOidc' -> 'domain' ->> 'verificationToken'),
  CASE
    WHEN auth_config::jsonb -> 'ssoOidc' -> 'domain' ->> 'verifiedAt' IS NOT NULL
      THEN (auth_config::jsonb -> 'ssoOidc' -> 'domain' ->> 'verifiedAt')::timestamptz
    ELSE NULL
  END,
  COALESCE((auth_config::jsonb -> 'ssoOidc' ->> 'enforced')::boolean, false),
  now()
FROM "settings"
WHERE auth_config IS NOT NULL
  AND auth_config::jsonb -> 'ssoOidc' -> 'domain' ->> 'name' IS NOT NULL;

-- Strip the now-orphaned keys from authConfig.ssoOidc and bump the
-- auth-config version so live pods rebuild their Better-Auth instance
-- on the next request rather than waiting for the settings cache TTL.
UPDATE "settings"
SET
  auth_config = (
    (auth_config::jsonb
      #- '{ssoOidc,domain}'
      #- '{ssoOidc,enforced}'
    )::text
  ),
  auth_config_version = auth_config_version + 1
WHERE auth_config IS NOT NULL
  AND (
    (auth_config::jsonb -> 'ssoOidc') ? 'domain'
    OR (auth_config::jsonb -> 'ssoOidc') ? 'enforced'
  );
