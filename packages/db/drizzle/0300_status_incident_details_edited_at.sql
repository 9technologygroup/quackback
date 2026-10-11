-- @contract: additive
-- When an incident's details last changed through an edit that posts no
-- update: its title, its scheduled window, or its affected services. The
-- status feed tells readers about such an edit when it comes after the
-- latest update. Existing rows stay null: no edit of theirs is known, so
-- none is announced.
ALTER TABLE "status_incidents" ADD COLUMN IF NOT EXISTS "details_edited_at" timestamp with time zone;
