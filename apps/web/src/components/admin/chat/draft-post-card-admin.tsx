import { Link } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  EnvelopeIcon,
  LightBulbIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline'
import type { ChatMessageId } from '@quackback/ids'
import { Button } from '@/components/ui/button'
import { nudgeDraftPostFn } from '@/lib/server/functions/chat'
import type { ChatCard } from '@/lib/shared/db-types'
import type { ChatCardView } from '@/lib/shared/chat/types'

// Shared admin tokens — bordered card on a faint fill, muted labels, and a
// pill-shaped status chip (mirrors channel-badge / the inbox status chips).
const cardCls = 'rounded-md border border-border bg-muted/20 px-3 py-2'
const pillCls =
  'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium'
const labelCls = 'flex items-center gap-1 text-[11px] text-muted-foreground'
const linkCls =
  'mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline underline-offset-2'

type DraftStatus = Extract<ChatCard, { type: 'draft_post' }>['status']

/**
 * Read-only render of a chat card (`message.card`) for the agent inbox. The
 * agent proposed or shared the card; the *visitor* is the one who acts on it, so
 * this view carries no buttons — just the content and the card's current state,
 * which updates live via the `card_updated` stream. When the server-resolved
 * `cardView` is present, the card shows the board name, post title, vote count,
 * and a status chip; otherwise it falls back to the raw ids.
 */
export function DraftPostCardAdmin({
  card,
  cardView,
  createdAt,
  messageId,
}: {
  card: ChatCard
  cardView: ChatCardView | null
  createdAt: string
  messageId: ChatMessageId
}) {
  // No enrichment (referenced board/post is gone, or an SSE-delivered message
  // hasn't been enriched yet) — fall back to the raw-id rendering.
  if (!cardView) return <RawCard card={card} />

  if (card.type === 'post_ref' && cardView.type === 'post_ref') {
    return (
      <div className={cardCls}>
        <p className={labelCls}>
          <LightBulbIcon className="size-3 shrink-0" />
          Shared a post
        </p>
        <p className="mt-1 text-sm font-medium text-foreground">{cardView.title}</p>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="truncate">{cardView.boardName}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">{cardView.voteCount}▲</span>
          {cardView.statusName && (
            <StatusDot name={cardView.statusName} color={cardView.statusColor} />
          )}
        </div>
        <Link to="/admin/feedback" search={{ post: card.postId }} className={linkCls}>
          View post
          <ArrowTopRightOnSquareIcon className="size-3" />
        </Link>
      </div>
    )
  }

  if (card.type === 'draft_post' && cardView.type === 'draft_post') {
    return (
      <div className={cardCls}>
        <div className={labelCls}>
          <LightBulbIcon className="size-3 shrink-0" />
          <span>Draft feedback post</span>
          <DraftStatusChip status={card.status} />
        </div>
        <p className="mt-1 text-sm font-medium text-foreground">
          {card.status === 'published' && cardView.postTitle ? cardView.postTitle : card.title}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">in {cardView.boardName}</p>
        {card.status === 'published' && card.postId && (
          <Link to="/admin/feedback" search={{ post: card.postId }} className={linkCls}>
            View post
            <ArrowTopRightOnSquareIcon className="size-3" />
          </Link>
        )}
        {card.status === 'proposed' && (
          <DraftNudgeFooter createdAt={createdAt} messageId={messageId} />
        )}
      </div>
    )
  }

  // Discriminant mismatch (shouldn't happen) — safe raw fallback.
  return <RawCard card={card} />
}

/** Small status chip with a colored dot, tinted from the workspace status color. */
function StatusDot({ name, color }: { name: string; color: string | null }) {
  return (
    <span
      className={`${pillCls} ms-1`}
      style={color ? { backgroundColor: `${color}1a`, color } : undefined}
    >
      {color && (
        <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      )}
      {name}
    </span>
  )
}

function DraftStatusChip({ status }: { status: DraftStatus }) {
  if (status === 'published') {
    return (
      <span
        className={`${pillCls} ms-auto bg-emerald-500/10 text-emerald-600 dark:text-emerald-400`}
      >
        <CheckCircleIcon className="size-3" />
        Posted
      </span>
    )
  }
  if (status === 'dismissed') {
    return (
      <span className={`${pillCls} ms-auto bg-muted text-muted-foreground`}>
        <XCircleIcon className="size-3" />
        Dismissed
      </span>
    )
  }
  return <span className={`${pillCls} ms-auto bg-muted text-muted-foreground`}>Proposed</span>
}

/**
 * Footer shown only while a draft is still proposed: the draft's age plus a
 * manual "Nudge by email" button. An automatic reminder also fires a day after
 * the agent proposes, so this is just the manual override.
 */
function DraftNudgeFooter({
  createdAt,
  messageId,
}: {
  createdAt: string
  messageId: ChatMessageId
}) {
  // Only the server can resolve the visitor's deliverable email (account email,
  // contact email, or pre-chat capture), so the button is always clickable and
  // the result tells the agent whether a reminder actually went out.
  const nudge = useMutation({
    mutationFn: () => nudgeDraftPostFn({ data: { messageId } }),
    onSuccess: (res) =>
      res.sent ? toast.success('Reminder sent') : toast.error('Visitor has no email on file'),
    onError: () => toast.error('Could not send reminder'),
  })

  return (
    <div className="mt-1.5 flex items-center justify-between gap-2">
      <span className="text-[11px] text-muted-foreground">
        Awaiting visitor · {formatDistanceToNow(new Date(createdAt), { addSuffix: true })}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-6 gap-1 px-2 text-[11px]"
        disabled={nudge.isPending}
        onClick={() => nudge.mutate()}
      >
        <EnvelopeIcon className="size-3" />
        Nudge by email
      </Button>
    </div>
  )
}

/** Pre-enrichment fallback: prints the raw card ids (no board/post lookup). */
function RawCard({ card }: { card: ChatCard }) {
  if (card.type === 'post_ref') {
    return (
      <div className={cardCls}>
        <p className={labelCls}>
          <LightBulbIcon className="size-3 shrink-0" />
          Shared post
        </p>
        <p className="mt-0.5 truncate text-xs text-foreground/80" title={card.postId}>
          {card.postId}
        </p>
      </div>
    )
  }

  return (
    <div className={cardCls}>
      <div className={labelCls}>
        <LightBulbIcon className="size-3 shrink-0" />
        <span>Suggested post</span>
        <span aria-hidden>·</span>
        <span className="truncate" title={card.boardId}>
          {card.boardId}
        </span>
        <DraftStatusChip status={card.status} />
      </div>
      <p className="mt-1 text-sm font-medium text-foreground">{card.title}</p>
      {card.content && (
        <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap text-xs text-muted-foreground">
          {card.content}
        </p>
      )}
      {card.status === 'published' && card.postId && (
        <p className="mt-1 truncate text-[11px] text-muted-foreground/70" title={card.postId}>
          Post {card.postId}
        </p>
      )}
    </div>
  )
}
