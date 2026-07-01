-- Post-child object symmetry: comments -> post_comments (posts -> comments).
-- Uniform `post*` naming for all post-child tables. Metadata-only rename; the
-- `comment` TypeID prefix is unchanged (later stored-id pass).

ALTER TABLE "comments" RENAME TO "post_comments";
ALTER INDEX "comments_post_id_idx" RENAME TO "post_comments_post_id_idx";
ALTER INDEX "comments_parent_id_idx" RENAME TO "post_comments_parent_id_idx";
ALTER INDEX "comments_principal_id_idx" RENAME TO "post_comments_principal_id_idx";
ALTER INDEX "comments_created_at_idx" RENAME TO "post_comments_created_at_idx";
ALTER INDEX "comments_post_created_at_idx" RENAME TO "post_comments_post_created_at_idx";
ALTER INDEX "comments_moderation_state_idx" RENAME TO "post_comments_moderation_state_idx";
ALTER INDEX "comments_status_change_to_id_idx" RENAME TO "post_comments_status_change_to_id_idx";
