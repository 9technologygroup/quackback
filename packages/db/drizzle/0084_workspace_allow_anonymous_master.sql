-- Collapse the three workspace-level anonymous-access toggles
-- (`features.anonymousVoting`, `features.anonymousCommenting`,
-- `features.anonymousPosting`) into a single master switch
-- `features.allowAnonymous`.
--
-- Preserving end-user behaviour requires two passes:
--   1. Bump per-board access tiers: any action whose workspace flag was
--      false AND whose board tier was 'anonymous' is raised to
--      'authenticated'. This way the ceiling that the workspace used to
--      enforce as a kill switch is now reified in the per-board tier,
--      and we can default `allowAnonymous=true` without re-enabling
--      anonymous interaction on boards the admin had locked down via
--      the workspace toggles.
--   2. Rewrite `features`: drop the three legacy keys, set
--      `allowAnonymous=true`. The default is `true` because the per-
--      board bump above has already encoded any prior restrictions.
--
-- Mapping (workspace flag ↔ board action):
--   anonymousVoting     ↔ vote
--   anonymousCommenting ↔ comment
--   anonymousPosting    ↔ submit
--
-- `view` is never restricted at the workspace level today, so its tier
-- is left untouched.
--
-- `settings.portal_config` is stored as `text` (JSON serialised — see
-- migration 0000), so each read casts through `::jsonb` and each write
-- casts back to `::text`. `boards.access` is native `jsonb`.
--
-- The CTE materialises the old flags from the single-tenant settings
-- row. Absent keys are defaulted to MATCH the pre-0084
-- DEFAULT_PORTAL_CONFIG.features and the in-app deep-merge fallback:
--   anonymousVoting     -> true  (base default true; read as `?? true`)
--   anonymousCommenting -> false (base default false; deep-merge fallback)
--   anonymousPosting    -> false (base default false; read as `!...` => blocked)
-- Defaulting commenting/posting to `true` here would silently re-open
-- anonymous interaction on upgrade for any tenant whose stored config
-- predates these keys.
WITH old_features AS (
  SELECT
    COALESCE(((portal_config::jsonb)->'features'->>'anonymousVoting')::boolean, true) AS allow_vote,
    COALESCE(((portal_config::jsonb)->'features'->>'anonymousCommenting')::boolean, false) AS allow_comment,
    COALESCE(((portal_config::jsonb)->'features'->>'anonymousPosting')::boolean, false) AS allow_submit
  FROM "settings"
  WHERE portal_config IS NOT NULL
  LIMIT 1
)
UPDATE "boards" SET "access" = (
  SELECT
    jsonb_set(
      jsonb_set(
        jsonb_set(
          "boards"."access",
          '{vote}',
          CASE
            WHEN NOT old_features.allow_vote AND "boards"."access"->>'vote' = 'anonymous'
              THEN '"authenticated"'::jsonb
            ELSE "boards"."access"->'vote'
          END
        ),
        '{comment}',
        CASE
          WHEN NOT old_features.allow_comment AND "boards"."access"->>'comment' = 'anonymous'
            THEN '"authenticated"'::jsonb
          ELSE "boards"."access"->'comment'
        END
      ),
      '{submit}',
      CASE
        WHEN NOT old_features.allow_submit AND "boards"."access"->>'submit' = 'anonymous'
          THEN '"authenticated"'::jsonb
        ELSE "boards"."access"->'submit'
      END
    )
  FROM old_features
)
WHERE EXISTS (SELECT 1 FROM old_features);
--> statement-breakpoint
-- Step 2: rewrite the settings row's `features` object. The `#-`
-- operator strips each legacy key (no-op if absent); `jsonb_set` with
-- `create_missing=true` then writes the new master flag at
-- `{features,allowAnonymous}`. Cast through jsonb then back to text
-- since `portal_config` is text-typed JSON.
UPDATE "settings"
SET "portal_config" = jsonb_set(
  (portal_config::jsonb) #- '{features,anonymousVoting}'
                         #- '{features,anonymousCommenting}'
                         #- '{features,anonymousPosting}',
  '{features,allowAnonymous}',
  'true'::jsonb,
  true
)::text
WHERE portal_config IS NOT NULL;
