import { describe, it, expect } from 'vitest'
import { visibleSteps } from '../onboarding-steps'
import type { SetupState } from '@/lib/shared/db-types'

const baseState = (overrides?: Partial<SetupState>): SetupState => ({
  version: 1,
  steps: { core: false, workspace: false, boards: false },
  ...overrides,
})

describe('visibleSteps', () => {
  it('shows all four steps for a fresh self-hosted install with no session', () => {
    const labels = visibleSteps({ hasSession: false, setupState: null }).map((s) => s.label)
    expect(labels).toEqual(['Account', 'Use case', 'Workspace', 'Boards'])
  })

  it('hides the account step once the user has signed in', () => {
    const labels = visibleSteps({ hasSession: true, setupState: null }).map((s) => s.label)
    expect(labels).toEqual(['Use case', 'Workspace', 'Boards'])
  })

  it('hides the use-case step once setupState.useCase is set', () => {
    const labels = visibleSteps({
      hasSession: true,
      setupState: baseState({ useCase: 'saas' }),
    }).map((s) => s.label)
    expect(labels).toEqual(['Workspace', 'Boards'])
  })

  it('hides the workspace step once steps.workspace is true', () => {
    const labels = visibleSteps({
      hasSession: true,
      setupState: baseState({ steps: { core: true, workspace: true, boards: false } }),
    }).map((s) => s.label)
    expect(labels).toEqual(['Use case', 'Boards'])
  })

  it('pre-seeded tenant shows only the steps still owed', () => {
    // Workspace name + use case stamped at deploy time (file-watcher
    // reconciles spec.config.workspace). The user shows up in /onboarding/account
    // first (no session yet), creates an account, then sees just
    // the boards step — not "Step 4 of 4".
    const setupState = baseState({
      useCase: 'saas',
      steps: { core: true, workspace: true, boards: false },
    })
    expect(visibleSteps({ hasSession: false, setupState }).map((s) => s.label)).toEqual([
      'Account',
      'Boards',
    ])
    expect(visibleSteps({ hasSession: true, setupState }).map((s) => s.label)).toEqual(['Boards'])
  })

  it('returns an empty list when every step is already done', () => {
    expect(
      visibleSteps({
        hasSession: true,
        setupState: baseState({
          useCase: 'saas',
          steps: { core: true, workspace: true, boards: true },
        }),
      })
    ).toEqual([])
  })
})
