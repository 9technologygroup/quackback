import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { SignalIcon } from '@heroicons/react/24/solid'
import { BackLink } from '@/components/ui/back-link'
import { PageHeader } from '@/components/shared/page-header'
import { StatusGeneralCard } from '@/components/admin/settings/status/status-general-card'
import { StatusVisibilityCard } from '@/components/admin/settings/status/status-visibility-card'
import { StatusNotificationsCard } from '@/components/admin/settings/status/status-notifications-card'
import { StatusDangerCard } from '@/components/admin/settings/status/status-danger-card'
import { updateStatusSettingsFn } from '@/lib/server/functions/status'
import { statusSettingsQueries } from '@/lib/client/queries/status'
import { DEFAULT_STATUS_SETTINGS, type StatusSettings } from '@/lib/shared/status-settings'
import { isProductEnabled } from '@/lib/shared/types/settings'

export const Route = createFileRoute('/admin/settings/status')({
  beforeLoad: ({ context }) => {
    if (!isProductEnabled(context.settings?.featureFlags, 'status')) {
      throw redirect({ to: '/admin/settings/general' })
    }
  },
  loader: async ({ context }) => {
    const { requireWorkspaceRole } = await import('@/lib/server/functions/workspace-utils')
    await requireWorkspaceRole({ data: { allowedRoles: ['admin'] } })
    await context.queryClient.ensureQueryData(statusSettingsQueries.get())
    return {}
  },
  component: StatusSettingsPage,
})

function StatusSettingsPage() {
  const queryClient = useQueryClient()
  const { data } = useSuspenseQuery(statusSettingsQueries.get())
  const [settings, setSettings] = useState<StatusSettings>(data ?? DEFAULT_STATUS_SETTINGS)

  // Text fields save debounced (a save per keystroke hammers the server);
  // switches/radios save immediately. Pending text is preserved across a
  // save response so an in-flight result can't clobber newer keystrokes.
  const pendingText = useRef<Partial<StatusSettings> | null>(null)
  const textTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const mutation = useMutation({
    mutationFn: (patch: Partial<StatusSettings>) => updateStatusSettingsFn({ data: patch }),
    onSuccess: (saved) => {
      setSettings((prev) =>
        pendingText.current ? { ...saved, pageDescription: prev.pageDescription } : saved
      )
      queryClient.setQueryData(statusSettingsQueries.get().queryKey, saved)
    },
  })

  const { mutate } = mutation
  const flushText = useCallback(() => {
    if (textTimer.current) {
      clearTimeout(textTimer.current)
      textTimer.current = null
    }
    const patch = pendingText.current
    pendingText.current = null
    if (patch) mutate(patch)
  }, [mutate])

  // Flush on unmount so navigating away never drops typed text.
  useEffect(() => flushText, [flushText])

  function onChange(patch: Partial<StatusSettings>) {
    setSettings((prev) => ({ ...prev, ...patch }))
    if ('pageDescription' in patch) {
      pendingText.current = { ...pendingText.current, ...patch }
      if (textTimer.current) clearTimeout(textTimer.current)
      textTimer.current = setTimeout(flushText, 600)
    } else {
      mutation.mutate(patch)
    }
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="lg:hidden">
        <BackLink to="/admin/settings">Settings</BackLink>
      </div>
      <PageHeader
        icon={SignalIcon}
        title="Status"
        description="Public status page for your services — incidents, maintenance, and uptime history."
      />

      <StatusGeneralCard
        settings={settings}
        onChange={onChange}
        onFlushText={flushText}
        disabled={mutation.isPending}
      />
      <StatusVisibilityCard settings={settings} onChange={onChange} disabled={mutation.isPending} />
      <StatusNotificationsCard
        settings={settings}
        onChange={onChange}
        disabled={mutation.isPending}
      />
      <StatusDangerCard />
    </div>
  )
}
