import { useMemo, useState } from 'react'
import { useSuspenseQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import {
  PERMISSION_CATALOGUE,
  PERMISSION_CATEGORIES,
  type PermissionKey,
} from '@/lib/shared/permissions'
import { CATEGORY_LABELS } from '@/lib/client/permission-labels'
import { usePermissions } from '@/lib/client/use-permissions'
import { settingsQueries } from '@/lib/client/queries/settings'
import { updateRoleFn } from '@/lib/server/functions/roles'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/shared/utils'

/**
 * Full-page permission editor for one custom role: the 15 catalogue
 * categories as tri-state groups, key rows with NEW badges for catalogue
 * keys added since the role's last edit, and the grant ceiling rendered as
 * disabled rows (the server enforces it independently).
 */
export function RoleEditor({ roleId }: { roleId: string }) {
  const { data } = useSuspenseQuery(settingsQueries.roles())
  const role = data.roles.find((r) => r.id === roleId)
  const held = usePermissions()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [name, setName] = useState(role?.name ?? '')
  const [description, setDescription] = useState(role?.description ?? '')
  const [selected, setSelected] = useState<Set<PermissionKey>>(
    () => new Set((role?.permissionKeys ?? []) as PermissionKey[])
  )
  const [search, setSearch] = useState('')
  // Collapsed by default; categories carrying newly-shipped keys start open
  // so the New badges are seen. Searching expands every matching category.
  const [openCats, setOpenCats] = useState<Set<string>>(
    () =>
      new Set(
        PERMISSION_CATALOGUE.filter((p) => (role?.newPermissionKeys ?? []).includes(p.key)).map(
          (p) => p.category
        )
      )
  )

  const newKeys = useMemo(
    () => new Set((role?.newPermissionKeys ?? []) as PermissionKey[]),
    [role?.newPermissionKeys]
  )

  const save = useMutation({
    mutationFn: () =>
      updateRoleFn({
        data: {
          roleId,
          name: name.trim(),
          description: description.trim() || null,
          permissionKeys: [...selected],
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings', 'roles'] })
      toast.success('Role saved')
      navigate({ to: '/admin/settings/members', search: { tab: 'roles' } })
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Couldn't save role. Try again.")
    },
  })

  if (!role) {
    return <p className="p-6 text-sm text-muted-foreground">Role not found.</p>
  }
  if (role.isSystem) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Built-in roles are read-only. Duplicate one from the Roles tab to customize it.
      </p>
    )
  }

  const query = search.trim().toLowerCase()
  const visible = PERMISSION_CATALOGUE.filter((p) => !query || p.key.toLowerCase().includes(query))

  const toggle = (key: PermissionKey) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div>
        <nav className="font-mono text-[11px] text-muted-foreground">
          <button
            type="button"
            className="hover:text-foreground"
            onClick={() => navigate({ to: '/admin/settings/members', search: { tab: 'roles' } })}
          >
            Members / Roles
          </button>
          <span> / {role?.name ?? '…'}</span>
        </nav>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="role-editor-name">Name</Label>
              <Input
                id="role-editor-name"
                className="max-w-xs font-medium"
                value={name}
                maxLength={64}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role-editor-description">Description</Label>
              <Input
                id="role-editor-description"
                className="w-full max-w-md"
                value={description}
                maxLength={280}
                placeholder="What is this role for?"
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 text-right">
            <Badge
              variant="outline"
              className="border-amber-300/60 bg-amber-50 uppercase tracking-wide text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
              size="sm"
            >
              Custom
            </Badge>
            <span className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
              {selected.size} of {PERMISSION_CATALOGUE.length} granted
            </span>
          </div>
        </div>
      </div>

      <Input
        className="max-w-sm"
        placeholder={`Filter ${PERMISSION_CATALOGUE.length} permissions…`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="space-y-3">
        {PERMISSION_CATEGORIES.map((category) => {
          const inCategory = visible.filter((p) => p.category === category)
          if (inCategory.length === 0) return null
          const grantedCount = inCategory.filter((p) => selected.has(p.key)).length
          const togglable = inCategory.filter((p) => held.has(p.key) || selected.has(p.key))
          const allOn = togglable.length > 0 && togglable.every((p) => selected.has(p.key))

          const isOpen = query ? true : openCats.has(category)
          return (
            <div key={category} className="rounded-lg border">
              <div
                className={cn(
                  'flex items-center gap-2.5 bg-muted/40 px-3.5 py-2',
                  isOpen && 'border-b'
                )}
              >
                <Checkbox
                  checked={grantedCount === 0 ? false : allOn ? true : 'indeterminate'}
                  disabled={togglable.length === 0}
                  aria-label={`Toggle all ${CATEGORY_LABELS[category]} permissions`}
                  onCheckedChange={(checked) => {
                    setSelected((prev) => {
                      const next = new Set(prev)
                      for (const p of inCategory) {
                        if (checked === true) {
                          // Category select-all only adds keys within the
                          // editor's own grant ceiling.
                          if (held.has(p.key)) next.add(p.key)
                        } else {
                          next.delete(p.key)
                        }
                      }
                      return next
                    })
                  }}
                />
                <button
                  type="button"
                  className="flex flex-1 items-center gap-2 text-left"
                  aria-expanded={isOpen}
                  onClick={() =>
                    setOpenCats((prev) => {
                      const next = new Set(prev)
                      if (next.has(category)) next.delete(category)
                      else next.add(category)
                      return next
                    })
                  }
                >
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {CATEGORY_LABELS[category]}
                  </span>
                  {inCategory.some((p) => newKeys.has(p.key)) && (
                    <Badge size="sm" variant="outline">
                      New
                    </Badge>
                  )}
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                    {grantedCount} of {inCategory.length}
                  </span>
                </button>
              </div>
              {isOpen && (
                <ul>
                  {inCategory.map((p) => {
                    // Above the editor's ceiling: can't be granted here. Still
                    // removable when already on the role (de-escalation is free).
                    const aboveCeiling = !held.has(p.key) && !selected.has(p.key)
                    return (
                      <li
                        key={p.key}
                        className={cn(
                          'flex items-center gap-2.5 border-b px-3.5 py-1.5 text-[13px] last:border-b-0',
                          aboveCeiling && 'opacity-50'
                        )}
                      >
                        <Checkbox
                          checked={selected.has(p.key)}
                          disabled={aboveCeiling}
                          aria-label={p.key}
                          onCheckedChange={() => toggle(p.key)}
                        />
                        <span className="font-mono text-xs">{p.key}</span>
                        {newKeys.has(p.key) && (
                          <Badge size="sm" variant="outline">
                            New
                          </Badge>
                        )}
                        {aboveCeiling && (
                          <span className="ml-auto hidden text-right text-xs text-muted-foreground sm:block">
                            You don't hold this
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </div>

      <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-lg border bg-background px-4 py-3 shadow-sm">
        <span className="text-xs text-muted-foreground">
          {selected.size} of {PERMISSION_CATALOGUE.length} granted
          {newKeys.size > 0 && (
            <>
              {' · '}
              <span className="font-medium text-foreground">
                {newKeys.size} permission{newKeys.size === 1 ? '' : 's'} added since last edit
              </span>
            </>
          )}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate({ to: '/admin/settings/members', search: { tab: 'roles' } })}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save role'}
          </Button>
        </div>
      </div>
    </div>
  )
}
