import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { PERMISSIONS } from '@/lib/shared/permissions'
import { RoleEditor } from '@/components/admin/settings/team/role-editor'

export const Route = createFileRoute('/admin/settings/members_/roles/new')({
  // `?from=<roleId>` preselects a duplicate source (the Duplicate action).
  validateSearch: z.object({ from: z.string().optional() }),
  beforeLoad: async () => {
    const { requireWorkspaceRole } = await import('@/lib/server/functions/workspace-utils')
    await requireWorkspaceRole({
      data: { allowedRoles: ['admin', 'member'], permission: PERMISSIONS.ROLE_MANAGE },
    })
  },
  component: NewRolePage,
})

function NewRolePage() {
  const { from } = Route.useSearch()
  return <RoleEditor key={from ?? 'blank'} mode="create" duplicateFromId={from} />
}
