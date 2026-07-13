import { useState, useEffect, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Cog6ToothIcon, ArrowPathIcon } from '@heroicons/react/24/solid'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { BackLink } from '@/components/ui/back-link'
import { PageHeader } from '@/components/shared/page-header'
import { SettingsCard } from '@/components/admin/settings/settings-card'
import { updateWorkspaceNameFn } from '@/lib/server/functions/settings'
import { updateFeatureFlagsFn } from '@/lib/server/functions/feature-flags'
import { isPathManagedFromBootstrap, MANAGED_PATHS } from '@/lib/client/config-file'
import {
  DEFAULT_FEATURE_FLAGS,
  PRODUCT_DEFINITIONS,
  getProductFlagUpdate,
  isProductEnabled,
  type FeatureFlags,
  type ProductId,
} from '@/lib/shared/types'
import { Switch } from '@/components/ui/switch'

export const Route = createFileRoute('/admin/settings/general')({
  loader: async () => {
    const { requireWorkspaceRole } = await import('@/lib/server/functions/workspace-utils')
    await requireWorkspaceRole({ data: { allowedRoles: ['admin'] } })
    return {}
  },
  component: GeneralSettingsPage,
})

function GeneralSettingsPage() {
  const { settings, managedFieldPaths } = Route.useRouteContext()
  const workspaceNameManaged = isPathManagedFromBootstrap(
    MANAGED_PATHS.WORKSPACE_NAME,
    managedFieldPaths ?? []
  )

  const [workspaceName, setWorkspaceName] = useState(settings?.name || '')
  const [isSavingName, setIsSavingName] = useState(false)
  const nameTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const [localFlags, setLocalFlags] = useState<FeatureFlags>(
    (settings?.featureFlags as FeatureFlags | undefined) ?? DEFAULT_FEATURE_FLAGS
  )
  const queryClient = useQueryClient()

  const productMutation = useMutation({
    mutationFn: (update: Partial<FeatureFlags>) => updateFeatureFlagsFn({ data: update }),
    onMutate: (update) => {
      let previous = localFlags
      setLocalFlags((current) => {
        previous = current
        return { ...current, ...update }
      })
      return { previous }
    },
    onSuccess: () => {
      queryClient.invalidateQueries()
      window.location.reload()
    },
    onError: (error, _update, context) => {
      if (context?.previous) setLocalFlags(context.previous)
      toast.error(error instanceof Error ? error.message : "Couldn't update product. Try again.")
    },
  })

  // Timer cleanup on unmount to prevent state updates after unmount
  useEffect(() => {
    return () => {
      if (nameTimeoutRef.current) clearTimeout(nameTimeoutRef.current)
    }
  }, [])

  // Debounced workspace name save
  const handleNameChange = (value: string) => {
    setWorkspaceName(value)
    if (nameTimeoutRef.current) {
      clearTimeout(nameTimeoutRef.current)
    }
    nameTimeoutRef.current = setTimeout(async () => {
      if (value.trim() && value !== settings?.name) {
        setIsSavingName(true)
        try {
          await updateWorkspaceNameFn({ data: { name: value.trim() } })
        } catch {
          toast.error('Failed to update workspace name')
        } finally {
          setIsSavingName(false)
        }
      }
    }, 800)
  }

  const handleProductToggle = (productId: ProductId, enabled: boolean) => {
    productMutation.mutate(getProductFlagUpdate(productId, enabled))
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="lg:hidden">
        <BackLink to="/admin/settings">Settings</BackLink>
      </div>
      <PageHeader
        icon={Cog6ToothIcon}
        title="General"
        description="Workspace identity and products"
      />

      <SettingsCard title="Workspace" description="The name shown across the portal and emails">
        <div className="max-w-md space-y-1.5">
          <Label htmlFor="workspace-name" className="text-xs text-muted-foreground">
            Workspace Name
          </Label>
          <div className="relative">
            <Input
              id="workspace-name"
              value={workspaceName}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="My Workspace"
              disabled={workspaceNameManaged}
            />
            {isSavingName && (
              <ArrowPathIcon className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </div>
          {workspaceNameManaged && (
            <p className="text-xs text-muted-foreground">
              Managed by your administrator&apos;s config &mdash; edit there.
            </p>
          )}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Products"
        description="Choose the Quackback products available to your team and customers"
      >
        <div className="divide-y divide-border/50">
          {PRODUCT_DEFINITIONS.map((product) => (
            <div
              key={product.id}
              className="flex items-center justify-between gap-6 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0 space-y-0.5">
                <Label
                  htmlFor={`product-${product.id}`}
                  className="cursor-pointer text-sm font-medium"
                >
                  {product.label}
                </Label>
                <p className="text-xs text-muted-foreground">{product.description}</p>
              </div>
              <Switch
                id={`product-${product.id}`}
                checked={isProductEnabled(localFlags, product.id)}
                onCheckedChange={(checked) => handleProductToggle(product.id, checked)}
                disabled={productMutation.isPending}
              />
            </div>
          ))}
        </div>
      </SettingsCard>
    </div>
  )
}
