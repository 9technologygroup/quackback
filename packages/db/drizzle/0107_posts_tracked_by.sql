-- The team member who tracked this post from a support conversation, on the
-- customer's behalf. The post's author stays the customer (principal_id); this
-- records who acted so the admin UI can show "tracked by X on behalf of Y".
-- Additive + backfill-safe (existing rows get NULL). Set null if the agent's
-- principal is later removed.

ALTER TABLE "posts" ADD COLUMN "tracked_by_principal_id" uuid;

ALTER TABLE "posts"
  ADD CONSTRAINT "posts_tracked_by_principal_id_fk"
  FOREIGN KEY ("tracked_by_principal_id") REFERENCES "principal"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "posts_tracked_by_principal_id_idx"
  ON "posts" ("tracked_by_principal_id")
  WHERE "tracked_by_principal_id" IS NOT NULL;
