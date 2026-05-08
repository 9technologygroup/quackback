import { describe, it, expect, vi } from 'vitest'
import { reconcileFileIntoDb, type ReconcileDeps } from '../reconciler'

const baseDeps = (): ReconcileDeps => ({
  readSettings: vi.fn(async () => ({
    id: 'ws_1',
    name: 'Old',
    slug: 'old',
    setupState: JSON.stringify({
      version: 1,
      steps: { core: true, workspace: false, boards: false },
    }),
    tierLimits: null,
    featureFlags: null,
    managedFieldPaths: [],
  })),
  updateSettings: vi.fn(async () => {}),
  invalidateSettingsCache: vi.fn(async () => {}),
  invalidateTierLimitsCache: vi.fn(async () => {}),
  resetAuth: vi.fn(async () => {}),
})

describe('reconcileFileIntoDb', () => {
  it('writes name + slug + managedFieldPaths when workspace is in spec', async () => {
    const deps = baseDeps()
    await reconcileFileIntoDb({ workspace: { name: 'Acme', slug: 'acme' } }, deps)
    expect(deps.updateSettings).toHaveBeenCalledTimes(1)
    const arg = (deps.updateSettings as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(arg.name).toBe('Acme')
    expect(arg.slug).toBe('acme')
    expect(arg.managedFieldPaths).toEqual(['workspace.name', 'workspace.slug'])
  })

  it('marks setupState.steps.workspace=true when workspace.name is managed', async () => {
    const deps = baseDeps()
    await reconcileFileIntoDb({ workspace: { name: 'Acme' } }, deps)
    const arg = (deps.updateSettings as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    const setup = JSON.parse(arg.setupState as string)
    expect(setup.steps.workspace).toBe(true)
  })

  it('writes tierLimits as a JSON-encoded string', async () => {
    const deps = baseDeps()
    await reconcileFileIntoDb({ tierLimits: { maxBoards: 7 } }, deps)
    const arg = (deps.updateSettings as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(JSON.parse(arg.tierLimits as string)).toEqual({ maxBoards: 7 })
    expect(arg.managedFieldPaths).toEqual(['tierLimits'])
  })

  it('per-key merges features over existing flags', async () => {
    const deps = baseDeps()
    deps.readSettings = vi.fn(async () => ({
      id: 'ws_1',
      name: 'X',
      slug: 'x',
      setupState: null,
      tierLimits: null,
      featureFlags: JSON.stringify({ helpCenter: false, other: true }),
      managedFieldPaths: [],
    }))
    await reconcileFileIntoDb({ features: { helpCenter: true } }, deps)
    const arg = (deps.updateSettings as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(JSON.parse(arg.featureFlags as string)).toEqual({ helpCenter: true, other: true })
    expect(arg.managedFieldPaths).toEqual(['features.helpCenter'])
  })

  it('clears managedFieldPaths when called with an empty spec', async () => {
    const deps = baseDeps()
    deps.readSettings = vi.fn(async () => ({
      id: 'ws_1',
      name: 'X',
      slug: 'x',
      setupState: null,
      tierLimits: null,
      featureFlags: null,
      managedFieldPaths: ['tierLimits', 'workspace.name'],
    }))
    await reconcileFileIntoDb({}, deps)
    const arg = (deps.updateSettings as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(arg.managedFieldPaths).toEqual([])
  })

  it('invalidates settings + tier-limits caches after every reconcile', async () => {
    const deps = baseDeps()
    await reconcileFileIntoDb({ tierLimits: { maxBoards: 1 } }, deps)
    expect(deps.invalidateSettingsCache).toHaveBeenCalledTimes(1)
    expect(deps.invalidateTierLimitsCache).toHaveBeenCalledTimes(1)
  })

  it('calls resetAuth when features are managed (auth plugins gate on flags)', async () => {
    const deps = baseDeps()
    await reconcileFileIntoDb({ features: { helpCenter: true } }, deps)
    expect(deps.resetAuth).toHaveBeenCalledTimes(1)
  })

  it('does NOT call resetAuth when only tierLimits change', async () => {
    const deps = baseDeps()
    await reconcileFileIntoDb({ tierLimits: { maxBoards: 1 } }, deps)
    expect(deps.resetAuth).not.toHaveBeenCalled()
  })

  it('skips updateSettings when nothing has changed', async () => {
    const deps = baseDeps()
    deps.readSettings = vi.fn(async () => ({
      id: 'ws_1',
      name: 'Acme',
      slug: 'acme',
      setupState: JSON.stringify({
        version: 1,
        steps: { core: true, workspace: true, boards: false },
      }),
      tierLimits: null,
      featureFlags: null,
      managedFieldPaths: ['workspace.name', 'workspace.slug'],
    }))
    await reconcileFileIntoDb({ workspace: { name: 'Acme', slug: 'acme' } }, deps)
    expect(deps.updateSettings).not.toHaveBeenCalled()
  })
})
