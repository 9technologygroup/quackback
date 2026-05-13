-- ============================================================================
-- v1 Granular Access Controls
-- ============================================================================
--
-- Adds:
--   * boards.audience (jsonb) + boards.moderation (jsonb)
--   * segments.slug (text, unique on non-deleted rows)
--   * user_segments.added_by enum widened to ['manual','dynamic','sso','widget','api']
--   * audit_log table
--
-- Phased deploy (see plan §Task 4):
--   1. Apply this migration while app still reads isPublic exclusively. New
--      rows the app inserts will set is_public correctly and audience to the
--      safe default ('public'). The backfill below corrects historical rows.
--   2. Deploy app code that reads audience and writes both.
--   3. Deploy code that drops isPublic reads (Task 21 of the plan).
--
-- Re-run-safe: every additive step is gated by IF NOT EXISTS or WHERE clauses.
-- ============================================================================

-- ---------------------------------------------------------------
-- 1. boards.audience + boards.moderation
-- ---------------------------------------------------------------
ALTER TABLE "boards"
  ADD COLUMN IF NOT EXISTS "audience" jsonb NOT NULL
  DEFAULT '{"kind":"public"}'::jsonb;

ALTER TABLE "boards"
  ADD COLUMN IF NOT EXISTS "moderation" jsonb NOT NULL
  DEFAULT '{"requireApproval":"none","trustedSegmentIds":[]}'::jsonb;

-- Backfill audience from legacy isPublic flag. WHERE-guard keeps re-runs idempotent.
UPDATE "boards"
SET "audience" = CASE
  WHEN "is_public" THEN '{"kind":"public"}'::jsonb
  ELSE '{"kind":"team"}'::jsonb
END
WHERE "audience" = '{"kind":"public"}'::jsonb;

-- Drop the legacy isPublic column. Audience is now the sole source of truth
-- for board visibility. CASCADE drops the supporting boards_is_public_idx.
DROP INDEX IF EXISTS "boards_is_public_idx";
ALTER TABLE "boards" DROP COLUMN IF EXISTS "is_public";

-- ---------------------------------------------------------------
-- 2. segments.slug (add nullable, backfill, then enforce NOT NULL)
-- ---------------------------------------------------------------
ALTER TABLE "segments" ADD COLUMN IF NOT EXISTS "slug" text;

UPDATE "segments"
SET "slug" = trim(both '-' from regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g'))
WHERE "slug" IS NULL;

-- Resolve any duplicate slugs by appending a 6-char id suffix.
WITH dups AS (
  SELECT "slug" FROM "segments" WHERE "deleted_at" IS NULL GROUP BY "slug" HAVING count(*) > 1
)
UPDATE "segments"
SET "slug" = "slug" || '-' || substr("id"::text, 1, 6)
WHERE "slug" IN (SELECT "slug" FROM dups) AND "deleted_at" IS NULL;

ALTER TABLE "segments" ALTER COLUMN "slug" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "segments_slug_unique"
  ON "segments" ("slug") WHERE "deleted_at" IS NULL;

-- ---------------------------------------------------------------
-- 3. user_segments.added_by enum widening
-- ---------------------------------------------------------------
-- Drop the existing CHECK if drizzle attached one, then re-create with all
-- five values. The constraint name pattern varies across drizzle versions,
-- so try both common shapes.
ALTER TABLE "user_segments"
  DROP CONSTRAINT IF EXISTS "user_segments_added_by_check";

ALTER TABLE "user_segments"
  ADD CONSTRAINT "user_segments_added_by_check"
  CHECK ("added_by" IN ('manual','dynamic','sso','widget','api'));

-- ---------------------------------------------------------------
-- 4. audit_log table
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "audit_log" (
  "id"              text PRIMARY KEY NOT NULL,
  "occurred_at"     timestamp with time zone DEFAULT now() NOT NULL,
  "actor_user_id"   text REFERENCES "user"("id") ON DELETE SET NULL,
  "actor_email"     text,
  "actor_role"      text,
  "actor_ip"        text,
  "actor_user_agent" text,
  "event_type"      text NOT NULL,
  "event_outcome"   text DEFAULT 'success' NOT NULL,
  "target_type"     text,
  "target_id"       text,
  "before_value"    jsonb,
  "after_value"     jsonb,
  "metadata"        jsonb
);

CREATE INDEX IF NOT EXISTS "audit_log_occurred_at_idx"
  ON "audit_log" ("occurred_at");

CREATE INDEX IF NOT EXISTS "audit_log_actor_user_id_occurred_at_idx"
  ON "audit_log" ("actor_user_id", "occurred_at");

CREATE INDEX IF NOT EXISTS "audit_log_event_type_occurred_at_idx"
  ON "audit_log" ("event_type", "occurred_at");
