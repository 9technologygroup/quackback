-- Maintenance started_at now records when a window actually started. Until
-- now it was stamped when the window was created, so a window scheduled for
-- next week said "Started <today>" and history dated it by creation. The app
-- now writes the planned start while a window is still scheduled and the real
-- start when it begins (automatically, "Start now", or a posted update).
--
-- Existing rows are corrected from the best record there is:
--   1. A window that has begun and isn't scheduled again has a timeline row
--      for it: automatic and manual starts both post an in_progress update,
--      and a window can also move straight to verifying. The first such
--      update is when it really started, early starts by hand included.
--   2. A window still scheduled, or one with no such update, takes its
--      planned start, matching what the app writes: a window still scheduled
--      holds its plan (even one started and moved back), and one moved
--      straight from scheduled to completed keeps it. A completed update is
--      not a start, or such a window would last no time at all.
-- Neither moves started_at past resolved_at: a window completed without
-- starting and later moved to in progress kept its resolved_at, and its
-- start update comes after it. Each only moves started_at later, so a row
-- created already under way keeps its creation time. Backfilled rows carry
-- their own historical times and are left alone.
--
-- The UPDATEs sit in a DO block so a fleet replay is a no-op: each leaves
-- started_at equal to the value it compares against, so a second run
-- matches nothing. A bare UPDATE would collapse the gap-heal window. Rows
-- the app writes from now on already hold these values (it dates a start
-- update at the start it records, and keeps a never-started window on its
-- plan), so a replay later matches none of them either.

-- @replay: guarded-by started_at being earlier than the first start update or scheduled_start_at; a row it updates ends equal to that value
DO $$
BEGIN
  UPDATE "status_incidents" AS i
  SET "started_at" = s."first_start"
  FROM (
    SELECT "incident_id", min("created_at") AS "first_start"
    FROM "status_incident_updates"
    WHERE "status" IN ('in_progress', 'verifying')
    GROUP BY "incident_id"
  ) AS s
  WHERE i."id" = s."incident_id"
    AND i."kind" = 'maintenance'
    AND i."backfilled" = false
    AND i."status" <> 'scheduled'
    AND i."started_at" < s."first_start"
    AND (i."resolved_at" IS NULL OR s."first_start" <= i."resolved_at");

  UPDATE "status_incidents" AS i
  SET "started_at" = i."scheduled_start_at"
  WHERE i."kind" = 'maintenance'
    AND i."backfilled" = false
    AND i."scheduled_start_at" IS NOT NULL
    AND i."started_at" < i."scheduled_start_at"
    AND (i."resolved_at" IS NULL OR i."scheduled_start_at" <= i."resolved_at")
    AND (
      i."status" = 'scheduled'
      OR NOT EXISTS (
        SELECT 1 FROM "status_incident_updates" AS u
        WHERE u."incident_id" = i."id"
          AND u."status" IN ('in_progress', 'verifying')
      )
    );
END $$;
