import { useState } from 'react'
import { useSuspenseQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import type { RoleId } from '@quackback/ids'
import { PERMISSIONS, PERMISSION_CATALOGUE, PERMISSION_CATEGORIES } from '@/lib/shared/permissions'
import { CATEGORY_LABELS } from '@/lib/client/permission-labels'
import { useHasPermission } from '@/lib/client/use-permissions'
import { settingsQueries } from '@/lib/client/queries/settings'
import { createRoleFn, deleteRoleFn, listRolesFn } from '@/lib/server/functions/roles'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/shared/utils'

/** The serialized shape the roles server fn returns across the boundary. */
type RolesPayload = Awaited<ReturnType<typeof listRolesFn>>
type RoleWithMeta = RolesPayload['roles'][number]

/**
 * Roles tab — a card grid over the roles table: the seeded presets
 * (read-only, duplicatable) plus custom roles (editable, deletable), a
 * dashed new-role tile, and the plan-cap banner when the operator set a
 * finite maxCustomRoles. Selecting a card opens its permission listing in a
 * full-width panel below the grid. Write affordances are gated on
 * role.manage (render-only; the server functions enforce for real).
 */
export function RolesTab() {
  const { data } = useSuspenseQuery(settingsQueries.roles())
  const { roles, maxCustomRoles } = data
  const canManage = useHasPermission(PERMISSIONS.ROLE_MANAGE)
  const [openRoleId, setOpenRoleId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [duplicateFrom, setDuplicateFrom] = useState<RoleWithMeta | null>(null)
  const [deleting, setDeleting] = useState<RoleWithMeta | null>(null)

  const customCount = roles.filter((r) => !r.isSystem).length
  const capReached = maxCustomRoles != null && customCount >= maxCustomRoles
  const openRole = roles.find((r) => r.id === openRoleId) ?? null

  const startCreate = (source: RoleWithMeta | null) => {
    setDuplicateFrom(source)
    setCreateOpen(true)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Built-in roles are read-only — duplicate one to customize it. Custom roles can grant any
          mix of permissions you hold yourself.
        </p>
        {canManage && (
          <Button
            size="sm"
            className="shrink-0"
            disabled={capReached}
            onClick={() => startCreate(null)}
          >
            New role
          </Button>
        )}
      </div>

      {maxCustomRoles != null && (
        <div className="rounded-lg border border-amber-300/50 bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          <strong>
            {customCount} of {maxCustomRoles}
          </strong>{' '}
          custom role{maxCustomRoles === 1 ? '' : 's'} used.
          {capReached && ' Your plan is at its custom-role limit.'}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {roles.map((role) => {
          const isOpen = openRoleId === role.id
          return (
            <div
              key={role.id}
              className={cn(
                'flex flex-col rounded-lg border bg-card p-3.5 transition-colors',
                isOpen && 'border-foreground/30'
              )}
            >
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => setOpenRoleId(isOpen ? null : role.id)}
                  aria-expanded={isOpen}
                >
                  <span className="truncate text-[13.5px] font-semibold">{role.name}</span>
                  <Badge
                    size="sm"
                    variant={role.isSystem ? 'secondary' : 'outline'}
                    className={cn(
                      'uppercase tracking-wide',
                      !role.isSystem &&
                        'border-amber-300/60 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                    )}
                  >
                    {role.isSystem ? 'Preset' : 'Custom'}
                  </Badge>
                </button>
                {canManage &&
                  (role.isSystem ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      disabled={capReached}
                      onClick={() => startCreate(role)}
                    >
                      Duplicate
                    </Button>
                  ) : (
                    <EditRoleButton roleId={role.id as RoleId} />
                  ))}
              </div>
              {role.description && (
                <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
                  {role.description}
                </p>
              )}
              <p className="mt-auto pt-2 font-mono text-[11px] text-muted-foreground/80">
                {role.permissionKeys.length} permissions
                {!role.isSystem && (
                  <>
                    {' · '}
                    {role.memberCount} member{role.memberCount === 1 ? '' : 's'}
                  </>
                )}
                {role.newPermissionKeys.length > 0 && (
                  <>
                    {' · '}
                    <span className="font-semibold text-foreground/70">
                      {role.newPermissionKeys.length} new
                    </span>
                  </>
                )}
              </p>
            </div>
          )
        })}
        {canManage && !capReached && (
          <button
            type="button"
            className="flex min-h-24 items-center justify-center rounded-lg border-[1.5px] border-dashed text-xs font-semibold text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            onClick={() => startCreate(null)}
          >
            + New role
          </button>
        )}
      </div>

      {openRole && (
        <div className="rounded-lg border">
          <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
            <span className="text-sm font-semibold">{openRole.name}</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {openRole.permissionKeys.length} of {PERMISSION_CATALOGUE.length} permissions
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              {canManage && !openRole.isSystem && (
                <Button variant="outline" size="sm" onClick={() => setDeleting(openRole)}>
                  Delete
                </Button>
              )}
              {canManage && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={capReached}
                  onClick={() => startCreate(openRole)}
                >
                  Duplicate
                </Button>
              )}
            </div>
          </div>
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            {PERMISSION_CATEGORIES.map((category) => {
              const granted = new Set(openRole.permissionKeys)
              const permsInCategory = PERMISSION_CATALOGUE.filter(
                (p) => p.category === category && granted.has(p.key)
              )
              if (permsInCategory.length === 0) return null
              return (
                <div key={category}>
                  <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {CATEGORY_LABELS[category]}
                  </h4>
                  <ul className="space-y-0.5">
                    {permsInCategory.map((p) => (
                      <li key={p.key} className="font-mono text-xs text-foreground/80">
                        {p.key}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <CreateRoleDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        roles={roles}
        initialDuplicateFrom={duplicateFrom}
      />
      <DeleteRoleDialog
        key={deleting?.id ?? 'none'}
        role={deleting}
        roles={roles}
        onOpenChange={() => setDeleting(null)}
      />
    </div>
  )
}

function EditRoleButton({ roleId }: { roleId: RoleId }) {
  const navigate = useNavigate()
  return (
    <Button
      variant="outline"
      size="sm"
      className="shrink-0"
      onClick={() => navigate({ to: '/admin/settings/members/roles/$roleId', params: { roleId } })}
    >
      Edit
    </Button>
  )
}

function CreateRoleDialog({
  open,
  onOpenChange,
  roles,
  initialDuplicateFrom,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  roles: RoleWithMeta[]
  initialDuplicateFrom: RoleWithMeta | null
}) {
  const [name, setName] = useState('')
  const [sourceId, setSourceId] = useState<string>('blank')
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // Reset per open so a previous duplicate choice doesn't leak into "New role".
  const [lastOpen, setLastOpen] = useState(false)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) {
      setSourceId(initialDuplicateFrom?.id ?? 'blank')
      setName(initialDuplicateFrom ? `${initialDuplicateFrom.name} copy`.slice(0, 64) : '')
    }
  }

  const create = useMutation({
    mutationFn: () =>
      createRoleFn({
        data: {
          name: name.trim(),
          duplicateFromRoleId: sourceId === 'blank' ? undefined : sourceId,
        },
      }),
    onSuccess: async ({ role, droppedKeys }) => {
      await queryClient.invalidateQueries({ queryKey: ['settings', 'roles'] })
      if (droppedKeys.length > 0) {
        toast.info(
          `${droppedKeys.length} permission${droppedKeys.length === 1 ? '' : 's'} you don't hold ${
            droppedKeys.length === 1 ? 'was' : 'were'
          } left off the duplicate.`
        )
      }
      onOpenChange(false)
      navigate({ to: '/admin/settings/members/roles/$roleId', params: { roleId: role.id } })
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Couldn't create role. Try again.")
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create role</DialogTitle>
          <DialogDescription>
            Start from an existing role's permissions, or from nothing.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="role-name">Name</Label>
            <Input
              id="role-name"
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              placeholder="Support Lead"
            />
          </div>
          <div className="space-y-2">
            <Label>Start from</Label>
            <Select value={sourceId} onValueChange={setSourceId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="blank">Blank — no permissions</SelectItem>
                {roles.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    Duplicate {r.name} · {r.permissionKeys.length} permissions
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create & edit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteRoleDialog({
  role,
  roles,
  onOpenChange,
}: {
  role: RoleWithMeta | null
  roles: RoleWithMeta[]
  onOpenChange: () => void
}) {
  const [reassignTo, setReassignTo] = useState<string>('')
  const queryClient = useQueryClient()

  const targets = roles.filter((r) => r.id !== role?.id && r.key !== 'owner')
  const needsReassign = (role?.memberCount ?? 0) > 0

  const remove = useMutation({
    mutationFn: () =>
      deleteRoleFn({
        data: {
          roleId: role!.id,
          reassignToRoleId: needsReassign ? reassignTo : undefined,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings', 'roles'] })
      await queryClient.invalidateQueries({ queryKey: ['settings', 'team'] })
      toast.success('Role deleted')
      onOpenChange()
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Couldn't delete role. Try again.")
    },
  })

  return (
    <Dialog open={role != null} onOpenChange={(v) => !v && onOpenChange()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete "{role?.name}"?</DialogTitle>
          <DialogDescription>
            {needsReassign
              ? `${role?.memberCount} member${role?.memberCount === 1 ? '' : 's'} hold this role. Choose the role they should move to — they keep workspace access either way.`
              : 'Nobody holds this role. This removes it permanently.'}
          </DialogDescription>
        </DialogHeader>
        {needsReassign && (
          <div className="space-y-2">
            <Label>Reassign members to</Label>
            <Select value={reassignTo} onValueChange={setReassignTo}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a role" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onOpenChange}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => remove.mutate()}
            disabled={remove.isPending || (needsReassign && !reassignTo)}
          >
            {remove.isPending ? 'Deleting…' : needsReassign ? 'Reassign & delete' : 'Delete role'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
