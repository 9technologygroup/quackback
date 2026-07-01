import { useState } from 'react'
import { ChevronDownIcon } from '@heroicons/react/24/solid'
import {
  SYSTEM_ROLES,
  SYSTEM_ROLE_PERMISSIONS,
  PERMISSION_CATALOGUE,
  PERMISSION_CATEGORIES,
  type SystemRoleKey,
} from '@/lib/shared/permissions'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/shared/utils'

/** The four seeded presets, in display order. Not editable yet (clone-to-customise
 *  is a later addition); this surface is read-only. */
const PRESETS: Array<{ key: SystemRoleKey; name: string; description: string }> = [
  {
    key: SYSTEM_ROLES.OWNER,
    name: 'Owner',
    description: 'Full access, including billing and role management.',
  },
  { key: SYSTEM_ROLES.ADMIN, name: 'Admin', description: 'Full access except billing.' },
  {
    key: SYSTEM_ROLES.MANAGER,
    name: 'Manager',
    description:
      'Configures and operates the whole product and inbox. No workspace-admin permissions.',
  },
  {
    key: SYSTEM_ROLES.CONTRIBUTOR,
    name: 'Contributor',
    description:
      'Cross-domain operator: works feedback and support queues. Does not configure product structure or settings.',
  },
]

const CATEGORY_LABELS: Record<string, string> = {
  workspace: 'Workspace',
  members: 'Members',
  people: 'People',
  company: 'Companies',
  audience: 'Audience',
  feedback: 'Feedback',
  changelog: 'Changelog',
  help_center: 'Help center',
  conversation: 'Inbox',
  analytics: 'Analytics',
  integration: 'Integrations',
  support: 'Support',
}

export function RolesTab() {
  const [openRole, setOpenRole] = useState<SystemRoleKey | null>(null)

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        These are the built-in roles and the permissions baked into each. They are read-only for
        now.
      </p>
      {PRESETS.map((preset) => {
        const granted = new Set(SYSTEM_ROLE_PERMISSIONS[preset.key])
        const isOpen = openRole === preset.key
        return (
          <div key={preset.key} className="rounded-lg border">
            <button
              type="button"
              onClick={() => setOpenRole(isOpen ? null : preset.key)}
              className="flex w-full items-start justify-between gap-3 p-4 text-left"
              aria-expanded={isOpen}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{preset.name}</span>
                  <Badge variant="secondary">{granted.size} permissions</Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{preset.description}</p>
              </div>
              <ChevronDownIcon
                className={cn(
                  'mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                  isOpen && 'rotate-180'
                )}
              />
            </button>
            {isOpen && (
              <div className="grid gap-4 border-t p-4 sm:grid-cols-2">
                {PERMISSION_CATEGORIES.map((category) => {
                  const permsInCategory = PERMISSION_CATALOGUE.filter(
                    (p) => p.category === category && granted.has(p.key)
                  )
                  if (permsInCategory.length === 0) return null
                  return (
                    <div key={category}>
                      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {CATEGORY_LABELS[category] ?? category}
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
            )}
          </div>
        )
      })}
    </div>
  )
}
