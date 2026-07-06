/**
 * Resolves a notification to the in-app route it should deep-link to.
 *
 * `NotificationTarget` is a plain descriptor rather than a route-typed
 * `LinkProps` value: the seven notification types fan out to routes with
 * different `params`/`search` shapes, and threading each one through the
 * router's generic `Link` typing here would fight the type system for no
 * safety gain (the shapes are validated by each destination route already).
 */
import type { SerializedNotification } from '@/lib/client/hooks/use-notifications-queries'

export interface NotificationTarget {
  to: string
  params?: Record<string, string>
  search?: Record<string, string>
  /** Unused until a follow-up work order adds comment-level anchors within a post/ticket thread. */
  hash?: string
}

export function getNotificationTarget(
  notification: SerializedNotification
): NotificationTarget | null {
  if (notification.post && notification.postId) {
    return {
      to: '/b/$slug/posts/$postId',
      params: { slug: notification.post.boardSlug, postId: notification.postId },
    }
  }

  // Conversation mentions and messages deep-link into the inbox conversation.
  // Recipients of both types are always team members (visitor-side
  // conversation updates go through the widget and email, never the bell),
  // so /admin/inbox is the correct target in both the dropdown and the full
  // notifications page.
  if (
    (notification.type === 'chat_mention' || notification.type === 'chat_message') &&
    notification.conversationId
  ) {
    return { to: '/admin/inbox', search: { c: notification.conversationId } }
  }

  // A ticket-stage change notifies the requester (portal); deep-link to the thread.
  if (notification.type === 'ticket_status_changed' && notification.ticketId) {
    return { to: '/support/ticket/$ticketId', params: { ticketId: notification.ticketId } }
  }

  // Deep-links to the specific changelog entry are a follow-up; for now land
  // on the changelog index.
  if (notification.type === 'changelog_published') {
    return { to: '/changelog' }
  }

  return null
}
