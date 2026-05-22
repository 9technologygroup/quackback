import { useState, useTransition } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { ShieldCheckIcon, ArrowPathIcon } from '@heroicons/react/24/solid'
import { settingsQueries } from '@/lib/client/queries/settings'
import { updateModerationDefaultFn } from '@/lib/server/functions/settings'
import { BackLink } from '@/components/ui/back-link'
import { PageHeader } from '@/components/shared/page-header'
import { SettingsCard } from '@/components/admin/settings/settings-card'
import { Switch } from '@/components/ui/switch'
import {
  requireApprovalToToggles,
  togglesToRequireApproval,
  type ApprovalToggles,
} from '@/lib/shared/moderation-policy'

export const Route = createFileRoute('/admin/settings/moderation')({
  loader: async ({ context }) => {
    const { requireWorkspaceRole } = await import('@/lib/server/functions/workspace-utils')
    await requireWorkspaceRole({ data: { allowedRoles: ['admin'] } })

    const { queryClient } = context
    await queryClient.ensureQueryData(settingsQueries.portalConfig())
    return {}
  },
  component: ModerationSettingsPage,
})

interface ModerationToggleProps {
  id: string
  label: string
  description: string
  checked: boolean
  saving?: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}

/** A single labelled toggle row — mirrors the Permissions page's idiom. */
function ModerationToggle({
  id,
  label,
  description,
  checked,
  saving,
  onCheckedChange,
  disabled,
}: ModerationToggleProps) {
  return (
    <div className="flex items-center justify-between py-4 first:pt-0 last:pb-0">
      <div className="pr-4">
        <label htmlFor={id} className="text-sm font-medium cursor-pointer">
          {label}
        </label>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        {saving && <ArrowPathIcon className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
      </div>
    </div>
  )
}

function ModerationSettingsPage() {
  const router = useRouter()
  const portalConfigQuery = useSuspenseQuery(settingsQueries.portalConfig())
  const [isPending, startTransition] = useTransition()
  const [toggles, setToggles] = useState<ApprovalToggles>(() =>
    requireApprovalToToggles(portalConfigQuery.data.moderationDefault?.requireApproval ?? 'none')
  )
  const [savingKey, setSavingKey] = useState<keyof ApprovalToggles | null>(null)

  // Each toggle independently saves: the two booleans are mapped back to the
  // single `requireApproval` enum the server stores. Optimistic with revert.
  async function update(key: keyof ApprovalToggles, checked: boolean) {
    const prev = toggles
    const next = { ...toggles, [key]: checked }
    setToggles(next)
    setSavingKey(key)
    try {
      await updateModerationDefaultFn({
        data: { requireApproval: togglesToRequireApproval(next) },
      })
      startTransition(() => router.invalidate())
    } catch {
      setToggles(prev)
    } finally {
      setSavingKey(null)
    }
  }

  const busy = savingKey !== null || isPending

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="lg:hidden">
        <BackLink to="/admin/settings">Settings</BackLink>
      </div>
      <PageHeader
        icon={ShieldCheckIcon}
        title="Moderation"
        description="The default approval policy for new posts. Boards can override it on their Access tab."
      />
      <SettingsCard
        title="Default approval policy"
        description="Posts from the selected groups wait for review before publishing. Applied to every board set to inherit."
      >
        <div className="divide-y divide-border/50">
          <ModerationToggle
            id="moderate-anonymous"
            label="Anonymous visitors"
            description="Hold posts from people without an account for review."
            checked={toggles.anonymous}
            saving={savingKey === 'anonymous'}
            onCheckedChange={(checked) => update('anonymous', checked)}
            disabled={busy}
          />
          <ModerationToggle
            id="moderate-authenticated"
            label="Signed-in portal users"
            description="Hold posts from signed-in portal users for review."
            checked={toggles.authenticated}
            saving={savingKey === 'authenticated'}
            onCheckedChange={(checked) => update('authenticated', checked)}
            disabled={busy}
          />
        </div>
      </SettingsCard>
    </div>
  )
}
