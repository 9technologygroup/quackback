/**
 * Conversation tags overview (Settings > Conversation data > Tags): the
 * org-wide label taxonomy with per-tag open-conversation counts that click
 * through to the filtered inbox. Management actions (rename, archive,
 * restore, delete) arrive with the tags-graduation phase.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { fetchConversationTagsWithCountsFn } from '@/lib/server/functions/conversation-tags'
import { SettingsCard } from '@/components/admin/settings/settings-card'

export function ConversationTagsManager() {
  const { data: tags } = useQuery({
    queryKey: ['admin', 'conversation-tags', 'settings'],
    queryFn: () => fetchConversationTagsWithCountsFn(),
  })

  return (
    <SettingsCard
      title="Conversation tags"
      description="Labels agents apply to conversations. Counts show open conversations; click through to see them in the inbox."
    >
      {!tags || tags.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No tags yet. Agents create them inline from a conversation.
        </p>
      ) : (
        <div>
          {tags.map((tag) => (
            <div
              key={tag.id}
              className="flex items-center gap-3 border-b border-border/50 py-3 last:border-0"
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: tag.color }}
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{tag.name}</span>
              <Link
                to="/admin/inbox"
                search={{ tag: tag.id }}
                className="shrink-0 text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                {tag.count} open
              </Link>
            </div>
          ))}
        </div>
      )}
    </SettingsCard>
  )
}
