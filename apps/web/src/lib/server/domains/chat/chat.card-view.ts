/**
 * Pure helpers that turn raw chat `ChatCard`s into display-ready `ChatCardView`s.
 * Kept side-effect free (no DB access) so they're unit-testable in isolation:
 * `collectCardRefs` gathers the ids a page of cards references, and
 * `buildCardView` assembles one view from pre-loaded board/post lookup maps.
 */
import type { ChatCard } from '@/lib/shared/db-types'
import type { ChatCardView } from '@/lib/shared/chat/types'

export interface BoardRow {
  name: string
  slug: string
}

export interface PostRow {
  title: string
  voteCount: number
  statusName: string | null
  statusColor: string | null
  boardSlug: string
  boardName: string
}

/** Gather every board id and post id referenced by a page of cards, so the
 *  caller can batch-load both in a single query each. */
export function collectCardRefs(cards: ChatCard[]): {
  boardIds: Set<string>
  postIds: Set<string>
} {
  const boardIds = new Set<string>()
  const postIds = new Set<string>()
  for (const card of cards) {
    if (card.type === 'draft_post') {
      boardIds.add(card.boardId)
      if (card.status === 'published' && card.postId) postIds.add(card.postId)
    } else {
      postIds.add(card.postId)
    }
  }
  return { boardIds, postIds }
}

/** Build the display view for a single card from the pre-loaded lookup maps.
 *  Returns null when the referenced board/post is missing (e.g. deleted). */
export function buildCardView(
  card: ChatCard,
  boards: Map<string, BoardRow>,
  posts: Map<string, PostRow>
): ChatCardView | null {
  if (card.type === 'draft_post') {
    const board = boards.get(card.boardId)
    if (!board) return null
    const post = card.postId ? posts.get(card.postId) : undefined
    return {
      type: 'draft_post',
      boardName: board.name,
      boardSlug: board.slug,
      ...(post ? { postTitle: post.title } : {}),
    }
  }
  const post = posts.get(card.postId)
  if (!post) return null
  return {
    type: 'post_ref',
    title: post.title,
    voteCount: post.voteCount,
    statusName: post.statusName,
    statusColor: post.statusColor,
    boardName: post.boardName,
    boardSlug: post.boardSlug,
  }
}
