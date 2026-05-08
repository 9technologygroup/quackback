import { computeManagedPaths } from './managed-paths'
import type { QuackbackConfigSpec } from './schema'

export interface SettingsRow {
  id: string
  name: string
  slug: string
  setupState: string | null
  tierLimits: string | null
  featureFlags: string | null
  managedFieldPaths: string[]
}

export interface SettingsUpdate {
  name?: string
  slug?: string
  setupState?: string
  tierLimits?: string
  featureFlags?: string
  managedFieldPaths: string[]
}

export interface ReconcileDeps {
  readSettings: () => Promise<SettingsRow | null>
  updateSettings: (update: SettingsUpdate) => Promise<void>
  invalidateSettingsCache: () => Promise<void>
  invalidateTierLimitsCache: () => Promise<void>
  resetAuth: () => Promise<void>
}

/**
 * Apply a parsed config spec to the settings row.
 *
 * Idempotent: when the resulting update would be a no-op (every
 * targeted field already matches), `updateSettings` is skipped. Cache
 * invalidations only fire when something actually changed.
 *
 * resetAuth fires when feature flags change, since Better-Auth's
 * plugin set is built from flags + settings at boot.
 */
export async function reconcileFileIntoDb(
  spec: QuackbackConfigSpec,
  deps: ReconcileDeps
): Promise<void> {
  const current = await deps.readSettings()
  if (!current) {
    // Nothing to reconcile against — settings row hasn't been created
    // yet (fresh-install pre-onboarding). The wizard will INSERT later;
    // the file's state lands on the next reconcile after that.
    return
  }

  const newPaths = computeManagedPaths(spec)
  const update: SettingsUpdate = { managedFieldPaths: newPaths }
  let touchedFeatures = false

  if (spec.workspace?.name !== undefined && spec.workspace.name !== current.name) {
    update.name = spec.workspace.name
  }
  if (spec.workspace?.slug !== undefined && spec.workspace.slug !== current.slug) {
    update.slug = spec.workspace.slug
  }

  if (spec.workspace !== undefined) {
    const setup = mergeSetupState(current.setupState, spec.workspace)
    const serialized = JSON.stringify(setup)
    if (serialized !== current.setupState) update.setupState = serialized
  }

  if (spec.tierLimits !== undefined) {
    const serialized = JSON.stringify(spec.tierLimits)
    if (serialized !== current.tierLimits) update.tierLimits = serialized
  }

  if (spec.features !== undefined) {
    const existing = current.featureFlags ? (safeJsonParse(current.featureFlags) ?? {}) : {}
    const merged = { ...existing, ...spec.features }
    const serialized = JSON.stringify(merged)
    if (serialized !== current.featureFlags) {
      update.featureFlags = serialized
      touchedFeatures = true
    }
  }

  const pathsChanged = !arrayEquals(newPaths, current.managedFieldPaths)
  const hasFieldUpdates = Object.keys(update).length > 1 // > 1 because managedFieldPaths is always set

  if (!pathsChanged && !hasFieldUpdates) {
    return
  }

  await deps.updateSettings(update)
  await deps.invalidateSettingsCache()
  await deps.invalidateTierLimitsCache()
  if (touchedFeatures) await deps.resetAuth()
}

interface SetupStateShape {
  version: number
  steps: { core: boolean; workspace: boolean; boards: boolean }
  useCase?: 'saas' | 'consumer' | 'marketplace' | 'internal'
  completedAt?: string
}

function mergeSetupState(
  existing: string | null,
  workspace: {
    name?: string
    slug?: string
    useCase?: 'saas' | 'consumer' | 'marketplace' | 'internal'
  }
): SetupStateShape {
  const parsed = existing ? (safeJsonParse(existing) as Partial<SetupStateShape> | null) : null
  const parsedSteps = parsed?.steps
  return {
    version: 1,
    steps: {
      core: parsedSteps?.core ?? true,
      workspace: workspace.name !== undefined ? true : (parsedSteps?.workspace ?? false),
      boards: parsedSteps?.boards ?? false,
    },
    useCase: workspace.useCase ?? parsed?.useCase,
    completedAt: parsed?.completedAt,
  }
}

function safeJsonParse(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function arrayEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  for (let i = 0; i < sortedA.length; i++) if (sortedA[i] !== sortedB[i]) return false
  return true
}
