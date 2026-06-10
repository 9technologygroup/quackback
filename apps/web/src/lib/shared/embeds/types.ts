/**
 * Serialized, viewer-safe previews for live Quackback link embeds.
 *
 * Produced by the embed resolver (`getEmbedPreviewFn`) and consumed by the
 * shared embed card. Only fields that are safe for any granted viewer to see
 * are projected here — gated data never reaches these shapes, and an embed the
 * viewer can't see degrades to {@link EmbedUnavailable} rather than leaking
 * existence.
 */

/** A tag chip on a post embed. */
export interface EmbedTag {
  id: string
  name: string
  color: string | null
}

/** A resolved feedback-post embed — a viewer-safe slice for a miniature post card. */
export interface EmbedPostPreview {
  kind: 'post'
  postId: string
  title: string
  /** Short plain-text preview of the body (already truncated server-side). */
  excerpt: string | null
  voteCount: number
  statusName: string | null
  statusColor: string | null
  boardName: string
  boardSlug: string
  tags: EmbedTag[]
  authorName: string | null
  authorAvatarUrl: string | null
  createdAt: string | null
  /** Absolute, viewer-shareable portal URL for the post — built server-side from
   *  the canonical base so an embed can open it in a new tab (e.g. in the widget,
   *  whose iframe origin may differ from the portal's). */
  url: string
}

/** A resolved (published) changelog-entry embed. */
export interface EmbedChangelogPreview {
  kind: 'changelog'
  entryId: string
  title: string
  publishedAt: string | null
  /** Absolute portal URL for the changelog entry — see {@link EmbedPostPreview.url}. */
  url: string
}

/** A resolved (published) help-center article embed. */
export interface EmbedArticlePreview {
  kind: 'article'
  /** Article slug — used as the embed identity and to build the relative navigation path. */
  articleId: string
  /** Category slug — needed for the two-segment help-center URL (`/hc/articles/{cat}/{slug}`). */
  categorySlug: string
  title: string
  /** Short plain-text preview of the article body (already truncated server-side). */
  excerpt: string | null
  /** Absolute portal URL for the article — see {@link EmbedPostPreview.url}. */
  url: string
}

/** A broken, deleted, or unauthorized embed — renders as a muted placeholder. */
export interface EmbedUnavailable {
  unavailable: true
}

export type EmbedPreview =
  | EmbedPostPreview
  | EmbedChangelogPreview
  | EmbedArticlePreview
  | EmbedUnavailable
