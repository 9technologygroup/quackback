import { useState } from 'react'
import {
  EllipsisVerticalIcon,
  TrashIcon,
  PencilSquareIcon,
  EnvelopeIcon,
  FaceSmileIcon,
  FlagIcon as FlagSolidIcon,
} from '@heroicons/react/24/solid'
import { FlagIcon } from '@heroicons/react/24/outline'
import { Avatar } from '@/components/ui/avatar'
import { ChatAttachmentList } from '@/components/shared/chat-attachments'
import { NoteContent } from './note-content'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { REACTION_EMOJIS } from '@/lib/shared/db-types'
import { cn } from '@/lib/shared/utils'
import type { AgentChatMessageDTO } from '@/lib/shared/chat/types'

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** A thin "New" divider rendered immediately above the first unread message. */
export function UnreadDivider() {
  return (
    <div className="my-1.5 flex items-center gap-2" role="separator" aria-label="New messages">
      <span className="h-px flex-1 bg-primary/30" />
      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
        New
      </span>
      <span className="h-px flex-1 bg-primary/30" />
    </div>
  )
}

interface AdminBubbleProps {
  message: AgentChatMessageDTO
  onDelete: () => void
  /** Toggle the caller's reaction with `emoji` (hasReacted = current state). */
  onToggleReaction: (emoji: string, hasReacted: boolean) => void
  /** Set/clear the team-wide flag (next = the desired flagged state). */
  onToggleFlag: (next: boolean) => void
  /** Mark the conversation unread from this message. */
  onMarkUnread: () => void
}

export function AdminBubble({
  message,
  onDelete,
  onToggleReaction,
  onToggleFlag,
  onMarkUnread,
}: AdminBubbleProps) {
  // Keep the hover toolbar visible while its emoji popover or overflow menu is
  // open (the pointer leaves the row to interact with the portal'd content).
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // System events (e.g. "assigned to …") are status notices, not messages:
  // centered, no avatar, no actions.
  if (message.senderType === 'system') {
    return (
      <div className="flex items-center gap-2 py-1" role="status">
        <span className="h-px flex-1 bg-border/40" />
        <span className="whitespace-nowrap px-2 text-[11px] text-muted-foreground">
          {message.content}
        </span>
        <span className="h-px flex-1 bg-border/40" />
      </div>
    )
  }

  // Internal notes are agent-only — rendered as a distinct full-width note.
  if (message.isInternal) {
    return (
      <div className="group relative rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm">
        <div className="mb-0.5 flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
          <PencilSquareIcon className="h-3 w-3" />
          {message.author?.displayName ?? 'Teammate'} · Internal note
        </div>
        <NoteContent
          content={message.content}
          contentJson={message.contentJson}
          className="text-foreground/90"
        />
        <span className="mt-0.5 block text-[10px] text-muted-foreground/50">
          {timeLabel(message.createdAt)}
        </span>
        <button
          type="button"
          onClick={onDelete}
          className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-amber-400/20 group-hover:opacity-100"
          aria-label="Delete note"
        >
          <TrashIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }

  // Threaded message: avatar + name on top, content below; a hover toolbar with
  // reactions, flag, and an overflow menu (mark-unread / delete). A flagged
  // message gets a tinted row + a flag marker under the avatar.
  const isAgent = message.senderType === 'agent'
  const authorName = message.author?.displayName ?? (isAgent ? 'Agent' : 'Visitor')
  const isFlagged = message.flaggedAt !== null
  const toolbarPinned = emojiOpen || menuOpen

  return (
    <div
      className={cn(
        'group relative -mx-2 flex gap-2.5 rounded-md px-2 py-1 transition-colors',
        isFlagged ? 'bg-amber-500/10 hover:bg-amber-500/15' : 'hover:bg-muted/40'
      )}
    >
      {/* Left gutter: avatar + (when flagged) a solid flag marker beneath it. */}
      <div className="flex shrink-0 flex-col items-center gap-1">
        <Avatar
          src={message.author?.avatarUrl ?? null}
          name={authorName}
          className="mt-0.5 size-9 text-xs"
        />
        {isFlagged && (
          <FlagSolidIcon className="size-3.5 text-amber-500" aria-label="Flagged" title="Flagged" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-xs font-semibold text-foreground">{authorName}</span>
          <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/50">
            {message.viaEmail && (
              <EnvelopeIcon
                className="h-3 w-3"
                aria-label="Received by email"
                title="Received by email"
              />
            )}
            {timeLabel(message.createdAt)}
          </span>
        </div>
        {message.content && (
          <div className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
            {message.content}
          </div>
        )}
        {message.attachments.length > 0 && <ChatAttachmentList attachments={message.attachments} />}
        {message.reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {message.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                onClick={() => onToggleReaction(r.emoji, r.hasReacted)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors',
                  r.hasReacted
                    ? 'border-primary/40 bg-primary/10 text-foreground'
                    : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted'
                )}
              >
                <span>{r.emoji}</span>
                <span className="tabular-nums">{r.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Hover toolbar */}
      <div
        className={cn(
          'absolute -top-3 right-2 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5 shadow-sm transition-opacity',
          toolbarPinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        )}
      >
        <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Add reaction"
            >
              <FaceSmileIcon className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto p-1">
            <div className="flex gap-0.5">
              {REACTION_EMOJIS.map((emoji) => {
                const has = message.reactions.some((r) => r.emoji === emoji && r.hasReacted)
                return (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => {
                      onToggleReaction(emoji, has)
                      setEmojiOpen(false)
                    }}
                    className="flex size-8 items-center justify-center rounded text-lg leading-none hover:bg-muted"
                  >
                    {emoji}
                  </button>
                )
              })}
            </div>
          </PopoverContent>
        </Popover>

        <button
          type="button"
          onClick={() => onToggleFlag(!isFlagged)}
          className={cn(
            'flex size-7 items-center justify-center rounded transition-colors hover:bg-muted',
            isFlagged ? 'text-amber-500' : 'text-muted-foreground hover:text-foreground'
          )}
          aria-label={isFlagged ? 'Remove flag' : 'Flag message'}
        >
          {isFlagged ? <FlagSolidIcon className="h-4 w-4" /> : <FlagIcon className="h-4 w-4" />}
        </button>

        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="More actions"
            >
              <EllipsisVerticalIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onMarkUnread}>
              <EnvelopeIcon className="h-4 w-4" /> Mark unread
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <TrashIcon className="h-4 w-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
