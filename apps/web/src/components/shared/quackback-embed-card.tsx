import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import { getEmbedPreviewFn } from '@/lib/server/functions/embeds'

// Bordered-card tokens copied (not imported) from draft-post-card-admin so this
// component stays self-contained — it hydrates into static HTML on display
// surfaces (post/comment/changelog bodies) where importing admin chrome is
// undesirable.
const cardCls = 'rounded-md border border-border bg-muted/20 px-3 py-2'
const pillCls =
  'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium'
const linkCls =
  'mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline underline-offset-2'

/**
 * A live Quackback link embed. Given a parsed `{ kind, id }`, it resolves the
 * referenced post/changelog *fresh* (votes, status, title all current) and
 * renders a compact bordered card. Anything the viewer can't see degrades to a
 * muted "unavailable" placeholder. Presentational + self-contained: it uses
 * plain `<a href>` (not the router `Link`) so it works on static display HTML
 * where the router context may be absent; relative hrefs resolve against the
 * current origin.
 */
export function QuackbackEmbedCard({ kind, id }: { kind: 'post' | 'changelog'; id: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['embed', kind, id],
    queryFn: () => getEmbedPreviewFn({ data: { kind, id } }),
    staleTime: 60_000,
  })

  if (isLoading || !data) {
    return (
      <div className={cardCls}>
        <div className="h-3.5 w-1/2 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-2.5 w-1/3 animate-pulse rounded bg-muted" />
      </div>
    )
  }

  if ('unavailable' in data) {
    return (
      <div className={`${cardCls} text-[11px] text-muted-foreground`}>
        This {kind === 'post' ? 'post' : 'update'} is unavailable
      </div>
    )
  }

  if (data.kind === 'post') {
    return (
      <div className={cardCls}>
        <p className="text-sm font-medium text-foreground">{data.title}</p>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="truncate">{data.boardName}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">{data.voteCount}▲</span>
          {data.statusName && <StatusDot name={data.statusName} color={data.statusColor} />}
        </div>
        <a href={`/b/${data.boardSlug}/posts/${data.postId}`} className={linkCls}>
          View post
          <ArrowTopRightOnSquareIcon className="size-3" />
        </a>
      </div>
    )
  }

  return (
    <div className={cardCls}>
      <p className="text-sm font-medium text-foreground">{data.title}</p>
      {data.publishedAt && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {format(new Date(data.publishedAt), 'MMM d, yyyy')}
        </p>
      )}
      <a href={`/changelog/${data.entryId}`} className={linkCls}>
        Read update
        <ArrowTopRightOnSquareIcon className="size-3" />
      </a>
    </div>
  )
}

/** Status chip with a colored dot, tinted from the workspace status color. */
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
