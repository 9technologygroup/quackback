import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { PlusIcon } from '@heroicons/react/24/solid'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TagChip } from '@/components/shared/tag-chip'
import type { ChatTagDTO } from '@/lib/shared/chat/types'
import type { ConversationId, ChatTagId } from '@quackback/ids'
import {
  fetchChatTagsFn,
  addConversationTagFn,
  removeConversationTagFn,
} from '@/lib/server/functions/chat-tags'

const CHAT_TAGS_KEY = ['admin', 'inbox', 'chat-tags'] as const

/**
 * Inline label editor for a conversation: the current labels as removable chips
 * plus a "+ Add" popover that filters existing labels and offers to create a new
 * one on the fly. Mutations invalidate the thread + the inbox list + the tag
 * list so chips, counts, and filters all stay in sync. Reused by the thread
 * header and the detail panel.
 */
export function ConversationTagsEditor({
  conversationId,
  tags,
}: {
  conversationId: ConversationId
  tags: ChatTagDTO[]
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  // Only fetch the full label list when the picker is open.
  const { data: allTags } = useQuery({
    queryKey: CHAT_TAGS_KEY,
    queryFn: () => fetchChatTagsFn(),
    enabled: open,
    staleTime: 60_000,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'inbox', 'thread', conversationId] })
    void queryClient.invalidateQueries({ queryKey: ['admin', 'inbox', 'conversations'] })
    void queryClient.invalidateQueries({ queryKey: CHAT_TAGS_KEY })
  }
  const addMut = useMutation({
    mutationFn: (v: { tagId?: ChatTagId; name?: string }) =>
      addConversationTagFn({ data: { conversationId, ...v } }),
    onSuccess: invalidate,
  })
  const removeMut = useMutation({
    mutationFn: (tagId: ChatTagId) => removeConversationTagFn({ data: { conversationId, tagId } }),
    onSuccess: invalidate,
  })

  const taggedIds = new Set(tags.map((t) => t.id))
  const q = query.trim().toLowerCase()
  const available = (allTags ?? []).filter((t) => !taggedIds.has(t.id))
  const filtered = q ? available.filter((t) => t.name.toLowerCase().includes(q)) : available
  const exactExists = (allTags ?? []).some((t) => t.name.toLowerCase() === q)

  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((t) => (
        <TagChip key={t.id} name={t.name} color={t.color} onRemove={() => removeMut.mutate(t.id)} />
      ))}
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setQuery('')
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground/70 transition-colors hover:border-border hover:bg-muted/40 hover:text-muted-foreground"
          >
            <PlusIcon className="h-2.5 w-2.5" />
            Add
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-1.5">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or create…"
            className="mb-1.5 w-full rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-primary/20"
          />
          <ScrollArea className="max-h-48">
            <div className="flex flex-col gap-0.5">
              {filtered.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    addMut.mutate({ tagId: t.id })
                    setQuery('')
                  }}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted/60"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: t.color }}
                  />
                  <span className="truncate text-xs">{t.name}</span>
                </button>
              ))}
              {q && allTags !== undefined && !exactExists && (
                <button
                  type="button"
                  onClick={() => {
                    addMut.mutate({ name: query.trim() })
                    setQuery('')
                  }}
                  className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-muted/60"
                >
                  <PlusIcon className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    Create “<span className="font-medium text-foreground">{query.trim()}</span>”
                  </span>
                </button>
              )}
              {allTags !== undefined && filtered.length === 0 && (!q || exactExists) && (
                <p className="px-1.5 py-1 text-xs text-muted-foreground">
                  {q ? 'Already added' : 'No labels yet'}
                </p>
              )}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  )
}
