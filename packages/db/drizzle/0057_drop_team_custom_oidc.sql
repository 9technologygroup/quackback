-- Drop team-side `custom-oidc` social-grid enablement.
--
-- Generic OIDC IdPs for the team surface are configured through the
-- Single sign-on panel (`auth_config.ssoOidc`), not the social grid.
-- The team-side social-grid tile was introduced on this branch and has
-- never shipped, so this is a defensive cleanup against dev/test data
-- rather than a production migration.
--
-- Portal keeps its `portal_config.oauth.custom-oidc` enablement
-- untouched — end users may continue signing in via the workspace's
-- chosen OIDC provider. `integration_platform_credentials` rows of type
-- `auth_custom-oidc` are also untouched (shared with portal).
--
-- The trailing `auth_config_version` bump invalidates cached Better-Auth
-- instances across pods on the next request, so the stripped key is
-- reflected immediately rather than after the settings cache TTL.
--
-- `managed_field_paths` is a `jsonb` array column (see migration 0053),
-- so deletions use the JSONB `-` operator and the existence check uses
-- the JSONB `?` operator — `array_remove` / `= ANY` only work on native
-- SQL array types.

UPDATE settings
SET
  auth_config = CASE
    WHEN auth_config IS NOT NULL AND (auth_config::jsonb -> 'oauth') ? 'custom-oidc'
      THEN (auth_config::jsonb #- '{oauth,custom-oidc}')::text
    ELSE auth_config
  END,
  managed_field_paths = managed_field_paths - 'auth.oauth.custom-oidc',
  auth_config_version = auth_config_version + 1
WHERE
  (auth_config IS NOT NULL AND (auth_config::jsonb -> 'oauth') ? 'custom-oidc')
  OR managed_field_paths ? 'auth.oauth.custom-oidc';
