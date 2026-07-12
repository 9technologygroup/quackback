import { createFileRoute } from '@tanstack/react-router'
import { BellIcon } from '@heroicons/react/24/solid'
import { BackLink } from '@/components/ui/back-link'
import { PageHeader } from '@/components/shared/page-header'
import { SettingsCard } from '@/components/admin/settings/settings-card'
import { NotificationMatrixForm } from '@/components/settings/notification-matrix-form'

export const Route = createFileRoute('/admin/settings/notifications')({
  loader: async () => {
    const { requireWorkspaceRole } = await import('@/lib/server/functions/workspace-utils')
    // Per-member page (each team member manages their own notification
    // preferences), so any team member may view it - not admin-gated.
    await requireWorkspaceRole({ data: { allowedRoles: ['admin', 'member'] } })
    return {}
  },
  component: NotificationsPage,
})

function NotificationsPage() {
  return (
    <div className="space-y-6 max-w-5xl">
      <div className="lg:hidden">
        <BackLink to="/admin/settings">Settings</BackLink>
      </div>
      <PageHeader
        icon={BellIcon}
        title="Notifications"
        description="Choose what you're notified about and how."
      />

      <SettingsCard>
        <NotificationMatrixForm surface="admin" />
      </SettingsCard>
    </div>
  )
}
