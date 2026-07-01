-- Post-child object symmetry: reactions on post comments become
-- post_comment_reactions (parent chain: posts -> comments -> reactions), matching
-- the post-prefixed sibling tables (post_notes, post_roadmaps, post_edit_history).
-- Metadata-only rename; the `reaction` TypeID prefix is unchanged (later pass).

ALTER TABLE "comment_reactions" RENAME TO "post_comment_reactions";
ALTER INDEX "comment_reactions_comment_id_idx" RENAME TO "post_comment_reactions_comment_id_idx";
ALTER INDEX "comment_reactions_principal_id_idx" RENAME TO "post_comment_reactions_principal_id_idx";
ALTER INDEX "comment_reactions_unique_idx" RENAME TO "post_comment_reactions_unique_idx";
