import { Link, useRouteContext, useRouterState } from '@tanstack/react-router'
import { useIntl } from 'react-intl'
import { BeakerIcon, BoltIcon, ChartBarIcon, SparklesIcon } from '@heroicons/react/24/solid'
import { MENU_ICON, MENU_ROW } from '@/components/ui/menu'
import { usePermission } from '@/lib/client/hooks/use-permission'
import { PERMISSIONS } from '@/lib/shared/permissions'
import { cn } from '@/lib/shared/utils'
import type { FeatureFlags } from '@/lib/shared/types/settings'

interface NavItem {
  labelId: string
  defaultLabel: string
  to: string
  icon: typeof SparklesIcon
}

interface AutomationNavPermissions {
  assistant: boolean
  workflows: boolean
  analytics: boolean
}

export function buildAutomationNavItems(
  flags: { supportInbox?: boolean } | undefined,
  permissions: AutomationNavPermissions
): NavItem[] {
  return [
    permissions.assistant
      ? {
          labelId: 'automation.nav.agent',
          defaultLabel: 'AI agent',
          to: '/admin/automation/agent',
          icon: SparklesIcon,
        }
      : null,
    permissions.workflows && flags?.supportInbox
      ? {
          labelId: 'automation.nav.workflows',
          defaultLabel: 'Workflows',
          to: '/admin/automation/workflows',
          icon: BoltIcon,
        }
      : null,
    permissions.assistant
      ? {
          labelId: 'automation.nav.test',
          defaultLabel: 'Test agent',
          to: '/admin/automation/test',
          icon: BeakerIcon,
        }
      : null,
    permissions.analytics
      ? {
          labelId: 'automation.nav.performance',
          defaultLabel: 'Performance',
          to: '/admin/automation/performance',
          icon: ChartBarIcon,
        }
      : null,
  ].filter((item): item is NavItem => item !== null)
}

export function AutomationNav() {
  const intl = useIntl()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const { settings } = useRouteContext({ from: '__root__' })
  const flags = settings?.featureFlags as FeatureFlags | undefined
  const permissions: AutomationNavPermissions = {
    assistant: usePermission(PERMISSIONS.ASSISTANT_MANAGE),
    workflows: usePermission(PERMISSIONS.WORKFLOW_MANAGE),
    analytics: usePermission(PERMISSIONS.ANALYTICS_VIEW),
  }
  const navItems = buildAutomationNavItems(flags, permissions)

  return (
    <nav
      aria-label={intl.formatMessage({
        id: 'automation.nav.label',
        defaultMessage: 'AI & Automation',
      })}
    >
      <div className="space-y-1">
        {navItems.map((item) => {
          const isActive = pathname === item.to || pathname.startsWith(`${item.to}/`)
          const Icon = item.icon
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                MENU_ROW,
                'min-h-9',
                isActive
                  ? 'bg-primary/10 font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground'
              )}
            >
              <Icon className={cn(MENU_ICON, isActive && 'text-primary')} />
              <span className="min-w-0 flex-1 truncate">
                {intl.formatMessage({ id: item.labelId, defaultMessage: item.defaultLabel })}
              </span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
