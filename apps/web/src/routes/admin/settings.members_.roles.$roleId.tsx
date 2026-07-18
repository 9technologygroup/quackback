import { createFileRoute } from '@tanstack/react-router'
import { PERMISSIONS } from '@/lib/shared/permissions'
import { RoleEditor } from '@/components/admin/settings/team/role-editor'

export const Route = createFileRoute('/admin/settings/members_/roles/$roleId')({
  // Viewable by anyone who can see the roster; the page renders read-only
  // without role.manage (and always for presets). Editing is enforced by the
  // server on save.
  beforeLoad: async () => {
    const { requireWorkspaceRole } = await import('@/lib/server/functions/workspace-utils')
    await requireWorkspaceRole({
      data: { allowedRoles: ['admin', 'member'], permission: PERMISSIONS.MEMBER_VIEW },
    })
  },
  component: RoleEditorPage,
})

function RoleEditorPage() {
  const { roleId } = Route.useParams()
  return <RoleEditor key={roleId} mode="edit" roleId={roleId} />
}
