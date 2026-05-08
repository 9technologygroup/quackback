import type { SetupState } from '@/lib/shared/db-types'

export type OnboardingStepDef = { path: string; label: string }

/**
 * Canonical full list of onboarding steps in the order they appear
 * when a fresh user first signs in. Workspaces whose `setupState` was
 * partially seeded by a provisioner (or by the config-file reconciler)
 * skip the corresponding steps via `visibleSteps`.
 */
export const ALL_ONBOARDING_STEPS: readonly OnboardingStepDef[] = [
  { path: '/onboarding/account', label: 'Account' },
  { path: '/onboarding/usecase', label: 'Use case' },
  { path: '/onboarding/workspace', label: 'Workspace' },
  { path: '/onboarding/boards', label: 'Boards' },
] as const

/**
 * Pick the steps the wizard should *display* given current state.
 * Steps that were pre-stamped (e.g. by the config-file watcher
 * reconciling spec.workspace) are hidden — the user shouldn't see
 * "Step 4 of 4" with three pre-checked boxes for things they didn't
 * do.
 *
 * Account is always shown when the user has no session: it's the only
 * step that creates the principal record. Other steps are gated on
 * their corresponding `setupState` fields.
 */
export function visibleSteps(opts: {
  hasSession: boolean
  setupState: SetupState | null
}): OnboardingStepDef[] {
  const { hasSession, setupState } = opts
  return ALL_ONBOARDING_STEPS.filter((step) => {
    switch (step.path) {
      case '/onboarding/account':
        return !hasSession
      case '/onboarding/usecase':
        return !setupState?.useCase
      case '/onboarding/workspace':
        return !setupState?.steps?.workspace
      case '/onboarding/boards':
        return !setupState?.steps?.boards
      default:
        return true
    }
  })
}
