'use client'

import { Link } from '@tanstack/react-router'
import { formatDistanceToNow, isToday, format } from 'date-fns'
import { cn } from '@/lib/shared/utils'
import { getNotificationTypeConfig } from './notification-type-config'
import { getNotificationTarget } from './notification-target'
import type { SerializedNotification } from '@/lib/client/hooks/use-notifications-queries'

interface NotificationItemProps {
  notification: SerializedNotification
  onMarkAsRead?: (id: SerializedNotification['id']) => void
  onClick?: () => void
  /** Layout variant: 'compact' for dropdown, 'full' for page view */
  variant?: 'compact' | 'full'
  /** Extra classes for the row root, e.g. staggered fade-in animation classes */
  className?: string
  /** Extra inline styles for the row root, e.g. per-row animation delay */
  style?: React.CSSProperties
}

export function NotificationItem({
  notification,
  onMarkAsRead,
  onClick,
  variant = 'compact',
  className,
  style,
}: NotificationItemProps) {
  const config = getNotificationTypeConfig(notification.type)
  const Icon = config.icon
  const isUnread = !notification.readAt
  const isFullVariant = variant === 'full'

  function handleClick(): void {
    if (isUnread && onMarkAsRead) {
      onMarkAsRead(notification.id)
    }
    onClick?.()
  }

  const content = isFullVariant ? (
    <FullContent
      notification={notification}
      icon={Icon}
      iconClass={config.iconClass}
      bgClass={config.bgClass}
      isUnread={isUnread}
    />
  ) : (
    <CompactContent
      notification={notification}
      icon={Icon}
      iconClass={config.iconClass}
      bgClass={config.bgClass}
      isUnread={isUnread}
    />
  )

  const target = getNotificationTarget(notification)

  if (target) {
    return (
      <Link
        to={target.to}
        params={target.params}
        search={target.search}
        hash={target.hash}
        onClick={handleClick}
        className={className}
        style={style}
      >
        {content}
      </Link>
    )
  }

  return (
    <div onClick={handleClick} className={className} style={style}>
      {content}
    </div>
  )
}

interface ContentProps {
  notification: SerializedNotification
  icon: React.ComponentType<{ className?: string }>
  iconClass: string
  bgClass: string
  isUnread: boolean
}

function CompactContent({ notification, icon: Icon, iconClass, bgClass, isUnread }: ContentProps) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50',
        isUnread && 'bg-primary/[0.02]'
      )}
    >
      <div
        className={cn(
          'flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center',
          bgClass
        )}
      >
        <Icon className={cn('h-4 w-4', iconClass)} />
      </div>

      <div className="flex-1 min-w-0 space-y-0.5">
        <p className={cn('text-sm leading-tight', isUnread ? 'font-medium' : 'text-foreground')}>
          {notification.title}
        </p>
        {notification.body && (
          <p className="text-xs text-muted-foreground line-clamp-2">{notification.body}</p>
        )}
        <p className="text-xs text-muted-foreground/70">
          {formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true })}
        </p>
      </div>

      {isUnread && <div className="flex-shrink-0 w-2 h-2 rounded-full bg-primary mt-1.5" />}
    </div>
  )
}

function FullContent({ notification, icon: Icon, iconClass, bgClass, isUnread }: ContentProps) {
  const createdAt = new Date(notification.createdAt)

  return (
    <div
      className={cn(
        'relative flex items-start gap-4 px-5 py-4 transition-colors hover:bg-muted/30',
        isUnread && 'bg-primary/[0.02]'
      )}
    >
      {isUnread && (
        <div className="absolute start-0 top-3 bottom-3 w-0.5 rounded-full bg-primary" />
      )}

      <div
        className={cn('flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center', bgClass)}
      >
        <Icon className={cn('h-4.5 w-4.5', iconClass)} />
      </div>

      <div className="flex-1 min-w-0">
        <p className={cn('text-sm leading-tight', isUnread ? 'font-medium' : 'text-foreground')}>
          {notification.title}
        </p>
        {notification.body && (
          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{notification.body}</p>
        )}
        <div className="flex items-center gap-2 mt-1">
          {notification.post && (
            <>
              <span className="text-[11px] text-muted-foreground/60 truncate max-w-[200px]">
                {notification.post.title}
              </span>
              <span className="text-muted-foreground/40">·</span>
            </>
          )}
          <time
            className="text-[11px] text-muted-foreground/60 whitespace-nowrap"
            dateTime={createdAt.toISOString()}
          >
            {isToday(createdAt)
              ? formatDistanceToNow(createdAt, { addSuffix: true })
              : format(createdAt, 'MMM d, h:mm a')}
          </time>
        </div>
      </div>

      {isUnread && (
        <div className="flex-shrink-0 w-2.5 h-2.5 rounded-full bg-primary mt-1.5 ring-4 ring-primary/10" />
      )}
    </div>
  )
}
