-- Post-child object symmetry: comment_edit_history -> post_comment_edit_history
-- (parent chain posts -> comments -> edit history). Metadata-only rename; the
-- `comment_edit` TypeID prefix is unchanged (later pass).

ALTER TABLE "comment_edit_history" RENAME TO "post_comment_edit_history";
ALTER INDEX "comment_edit_history_comment_id_idx" RENAME TO "post_comment_edit_history_comment_id_idx";
ALTER INDEX "comment_edit_history_created_at_idx" RENAME TO "post_comment_edit_history_created_at_idx";
