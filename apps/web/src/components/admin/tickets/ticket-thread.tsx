/**
 * The agent-facing ticket thread (support platform §4.2, 7C): a virtualized
 * message list + reply/internal-note composer for a customer ticket. Built on the
 * SAME shared thread core as the conversation inbox (thread.tsx + AgentMessageBubble
 * + the composers), but far leaner: a ticket carries no CSAT / typing / convert-to-
 * post / macros, and the message bubble renders read-only (no inbox reactions/flags/
 * delete toolbar). Live SSE arrives with the requester surfaces; for now a send
 * optimistically appends and the query refetches on focus.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { PaperAirplaneIcon, PaperClipIcon, PencilSquareIcon } from '@heroicons/react/24/solid'
import type { TicketId } from '@quackback/ids'
import type { JSONContent } from '@tiptap/core'
import type {
  ConversationAttachment,
  ConversationMessageDTO,
} from '@/lib/shared/conversation/types'
import {
  sendTicketMessageFn,
  addTicketNoteFn,
  listTicketMessagesFn,
} from '@/lib/server/functions/tickets'
import { ticketQueries, ticketKeys } from '@/lib/client/queries/tickets'
import { AgentMessageBubble } from '@/components/conversation/message-bubble'
import { asAgentMessage } from '@/components/conversation/events-reducer'
import {
  ThreadViewport,
  useThreadVirtualizer,
  useComposerDoc,
  docHasContentNode,
} from '@/components/conversation/thread'
import {
  ConversationRichComposer,
  type ConversationRichComposerHandle,
} from '@/components/admin/conversation/conversation-rich-composer'
import {
  ConversationNoteEditor,
  type ConversationNoteEditorHandle,
} from '@/components/admin/conversation/conversation-note-editor'
import { ComposerAttachmentTray } from '@/components/shared/composer-attachment-tray'
import { EmojiPicker } from '@/components/shared/emoji-picker'
import { Spinner } from '@/components/shared/spinner'
import { useImageUpload } from '@/lib/client/hooks/use-image-upload'
import { useConversationComposerAttachments } from '@/lib/client/hooks/use-conversation-composer-attachments'
import { cn } from '@/lib/shared/utils'

interface TicketThreadCache {
  messages: ConversationMessageDTO[]
  hasMore: boolean
}

type Row = { key: string } & (
  | { type: 'message'; message: ConversationMessageDTO }
  | { type: 'load-older' }
  | { type: 'empty' }
)

export function TicketThread({ ticketId }: { ticketId: TicketId }) {
  const queryClient = useQueryClient()
  const threadKey = ticketKeys.thread(ticketId)

  const reply = useComposerDoc()
  const note = useComposerDoc()
  const [noteMode, setNoteMode] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const replyRef = useRef<ConversationRichComposerHandle>(null)
  const noteRef = useRef<ConversationNoteEditorHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { data, isLoading } = useQuery(ticketQueries.thread(ticketId))
  const messages = data?.messages ?? []
  const hasMoreOlder = data?.hasMore ?? false

  const { upload } = useImageUpload({ endpoint: '/api/upload/image', prefix: 'chat-images' })
  const {
    pending: pendingAttachments,
    addFiles,
    remove: removeAttachment,
    clear: clearAttachments,
    uploading,
  } = useConversationComposerAttachments(upload)

  const rows: Row[] = useMemo(() => {
    const r: Row[] = []
    if (hasMoreOlder) r.push({ key: 'load-older', type: 'load-older' })
    for (const m of messages) r.push({ key: m.id, type: 'message', message: m })
    if (messages.length === 0 && !isLoading) r.push({ key: 'empty', type: 'empty' })
    return r
  }, [messages, hasMoreOlder, isLoading])

  const virtualizer = useThreadVirtualizer({
    rows,
    scrollRef,
    estimateSize: 72,
    loading: isLoading,
  })

  // After our own send lands, jump to the freshly-appended row. Deferred to a
  // layout effect so the new row exists in `rows` before we scroll.
  const pendingOwnSendScroll = useRef(false)
  useLayoutEffect(() => {
    if (!pendingOwnSendScroll.current || rows.length === 0) return
    pendingOwnSendScroll.current = false
    virtualizer.scrollToIndex(rows.length - 1, { align: 'end' })
  }, [rows.length, virtualizer])

  const append = (message: ConversationMessageDTO) => {
    queryClient.setQueryData<TicketThreadCache>(threadKey, (prev) => ({
      messages: [...(prev?.messages ?? []), message],
      hasMore: prev?.hasMore ?? false,
    }))
    pendingOwnSendScroll.current = true
  }

  const loadOlder = useCallback(async () => {
    if (loadingOlder || messages.length === 0) return
    setLoadingOlder(true)
    try {
      const page = await listTicketMessagesFn({ data: { ticketId, before: messages[0].id } })
      queryClient.setQueryData<TicketThreadCache>(threadKey, (prev) => ({
        messages: [...page.messages, ...(prev?.messages ?? [])],
        hasMore: page.hasMore,
      }))
    } catch {
      toast.error('Failed to load older messages')
    } finally {
      setLoadingOlder(false)
    }
  }, [ticketId, messages, loadingOlder, queryClient, threadKey])

  const sendMutation = useMutation({
    mutationFn: (vars: {
      content: string
      contentJson: JSONContent | null
      attachments?: ConversationAttachment[]
    }) => sendTicketMessageFn({ data: { ticketId, ...vars } }),
    onSuccess: (res) => {
      clearAttachments()
      append(res.message)
    },
    onError: () => toast.error('Failed to send reply'),
  })

  const noteMutation = useMutation({
    mutationFn: (vars: {
      content: string
      contentJson: JSONContent | null
      attachments?: ConversationAttachment[]
    }) => addTicketNoteFn({ data: { ticketId, ...vars } }),
    onSuccess: (res) => {
      clearAttachments()
      append(res.message)
    },
    onError: () => toast.error('Failed to add note'),
  })

  const onSend = useCallback(() => {
    if (noteMode) {
      const text = note.text.trim()
      if (!text || noteMutation.isPending || uploading) return
      noteMutation.mutate({
        content: text,
        contentJson: note.docRef.current,
        attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
      })
      note.clear()
      return
    }
    const text = reply.text.trim()
    const doc = reply.docRef.current
    const hasAttachments = pendingAttachments.length > 0
    if (
      (!text && !docHasContentNode(doc) && !hasAttachments) ||
      sendMutation.isPending ||
      uploading
    )
      return
    sendMutation.mutate({
      content: text,
      contentJson: doc,
      attachments: hasAttachments ? pendingAttachments : undefined,
    })
    reply.clear()
  }, [reply, note, noteMode, noteMutation, sendMutation, pendingAttachments, uploading])

  const renderRow = (row: Row) => {
    switch (row.type) {
      case 'load-older':
        return (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => void loadOlder()}
              disabled={loadingOlder}
              className="rounded-full border border-border/60 px-3 py-1 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50 transition-colors"
            >
              {loadingOlder ? 'Loading…' : 'Load earlier messages'}
            </button>
          </div>
        )
      case 'message':
        return <AgentMessageBubble message={asAgentMessage(row.message)} readOnly />
      case 'empty':
        return (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No replies yet. Send the first message to the requester.
          </p>
        )
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ThreadViewport
          virtualizer={virtualizer}
          rows={rows}
          renderRow={renderRow}
          viewportRef={scrollRef}
          className="min-h-0 flex-1"
          rowClassName="px-5 py-1.5"
        />
      </div>

      {/* Composer */}
      <div className="border-t border-border/50 p-3">
        <div className="mb-2 flex gap-1">
          {(
            [
              { mode: false, label: 'Reply' },
              { mode: true, label: 'Note' },
            ] as const
          ).map(({ mode, label }) => (
            <button
              key={label}
              type="button"
              onClick={() => setNoteMode(mode)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                noteMode === mode
                  ? mode
                    ? 'bg-amber-400/20 text-amber-700 dark:text-amber-300'
                    : 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          className={cn(
            'rounded-lg border px-3 py-2 focus-within:ring-2',
            noteMode
              ? 'border-amber-400/50 bg-amber-400/5 focus-within:ring-amber-400/20'
              : 'border-border bg-background focus-within:ring-primary/20'
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files
              if (files && files.length > 0) void addFiles(files)
              e.target.value = ''
            }}
          />
          {noteMode ? (
            <ConversationNoteEditor
              ref={noteRef}
              resetSignal={note.resetSignal}
              disabled={noteMutation.isPending}
              onChange={note.onChange}
              onSubmit={onSend}
              onImageFiles={(files) => void addFiles(files)}
            />
          ) : (
            <ConversationRichComposer
              ref={replyRef}
              resetSignal={reply.resetSignal}
              disabled={sendMutation.isPending}
              placeholder="Reply to the requester…"
              onChange={reply.onChange}
              onSubmit={onSend}
              onImageFiles={(files) => void addFiles(files)}
            />
          )}
          <ComposerAttachmentTray attachments={pendingAttachments} onRemove={removeAttachment} />
          <div className="flex items-center gap-0.5 pt-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-40 transition-colors"
              aria-label="Attach image"
            >
              <PaperClipIcon className="h-4 w-4" />
            </button>
            <EmojiPicker
              className="size-8"
              onSelect={(emoji) => {
                if (noteMode) noteRef.current?.insertText(emoji)
                else replyRef.current?.insertText(emoji)
              }}
            />
            <div className="flex-1" />
            <button
              type="button"
              onClick={onSend}
              disabled={
                noteMode
                  ? !note.text.trim() || noteMutation.isPending || uploading
                  : (!reply.text.trim() &&
                      !reply.hasContentNode &&
                      pendingAttachments.length === 0) ||
                    sendMutation.isPending ||
                    uploading
              }
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-md text-primary-foreground disabled:opacity-40 transition-opacity',
                noteMode ? 'bg-amber-500 text-white' : 'bg-primary'
              )}
              aria-label={noteMode ? 'Add note' : 'Send reply'}
            >
              {noteMode ? (
                <PencilSquareIcon className="h-4 w-4" />
              ) : (
                <PaperAirplaneIcon className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
