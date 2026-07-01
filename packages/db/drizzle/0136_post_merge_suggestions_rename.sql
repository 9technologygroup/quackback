-- Post-child object symmetry: merge_suggestions -> post_merge_suggestions
-- (posts -> merge_suggestions). Matches the post-prefixed sibling tables
-- (post_votes, post_comments, post_notes). Metadata-only rename that also
-- covers the auto-generated primary key and foreign key constraints in the
-- same migration (0135 pattern), since there is no later cleanup batch for
-- this one-off rename. The `merge_sug` TypeID prefix is flipped code-only to
-- post_merge_sug with NO stored-id pass (TypeIDs persist as native uuid, so
-- the prefix lives only in the app layer).

ALTER TABLE "merge_suggestions" RENAME TO "post_merge_suggestions";
ALTER INDEX "merge_suggestions_source_post_idx" RENAME TO "post_merge_suggestions_source_post_idx";
ALTER INDEX "merge_suggestions_target_post_idx" RENAME TO "post_merge_suggestions_target_post_idx";
ALTER INDEX "merge_suggestions_status_idx" RENAME TO "post_merge_suggestions_status_idx";
ALTER INDEX "merge_suggestions_created_idx" RENAME TO "post_merge_suggestions_created_idx";
ALTER INDEX "merge_suggestions_pending_unique_idx" RENAME TO "post_merge_suggestions_pending_unique_idx";

ALTER TABLE "post_merge_suggestions" RENAME CONSTRAINT "merge_suggestions_pkey" TO "post_merge_suggestions_pkey";
ALTER TABLE "post_merge_suggestions" RENAME CONSTRAINT "merge_suggestions_source_post_id_posts_id_fk" TO "post_merge_suggestions_source_post_id_posts_id_fk";
ALTER TABLE "post_merge_suggestions" RENAME CONSTRAINT "merge_suggestions_target_post_id_posts_id_fk" TO "post_merge_suggestions_target_post_id_posts_id_fk";
ALTER TABLE "post_merge_suggestions" RENAME CONSTRAINT "merge_suggestions_resolved_by_principal_id_principal_id_fk" TO "post_merge_suggestions_resolved_by_principal_id_principal_id_fk";
