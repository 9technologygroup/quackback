/**
 * Bootstrap-only admin promotion in the onboarding server fns.
 *
 * ensureAdminPrincipal used to promote ANY authenticated caller to admin
 * while setupState.steps.workspace was pending. These tests pin the
 * hardened behavior: promotion only happens while no human admin exists,
 * and a rejected caller must not write setupState.useCase on the way out.
 *
 * Uses the same createServerFn capture pattern as other suites in this
 * directory, except handler() returns a callable so the exported fn can
 * be driven directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const chain: Record<string, unknown> = {}
    chain.validator = () => chain
    chain.handler = (fn: (args: { data?: unknown }) => Promise<unknown>) =>
      Object.assign((args?: { data?: unknown }) => fn(args ?? {}), chain)
    return chain
  },
}))

const hoisted = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSettings: vi.fn(),
  principalFindFirst: vi.fn(),
  postStatusesFindFirst: vi.fn(),
  ensurePrincipalForUser: vi.fn(),
  setPrincipalRole: vi.fn(),
  dbUpdate: vi.fn(),
  dbInsert: vi.fn(),
  dbExecute: vi.fn(),
}))

vi.mock('@/lib/server/auth/session', () => ({ getSession: hoisted.getSession }))
vi.mock('@/lib/server/functions/workspace', () => ({ getSettings: hoisted.getSettings }))
vi.mock('@/lib/server/domains/principals/principal.service', () => ({
  syncPrincipalProfile: vi.fn(),
}))
vi.mock('@/lib/server/domains/principals/principal.factory', () => ({
  ensurePrincipalForUser: hoisted.ensurePrincipalForUser,
  setPrincipalRole: hoisted.setPrincipalRole,
}))
vi.mock('@/lib/server/domains/boards/board.service', () => ({ listBoards: vi.fn() }))
vi.mock('@/lib/server/domains/settings/settings.helpers', () => ({
  invalidateSettingsCache: vi.fn(),
}))
vi.mock('@/lib/server/domains/settings', () => ({
  DEFAULT_AUTH_CONFIG: { openSignup: false },
  DEFAULT_PORTAL_CONFIG: {},
}))
vi.mock('@/lib/server/config-file/managed-guard', () => ({
  assertNotManaged: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/server/config-file/managed-paths', () => ({
  isPathManaged: vi.fn(() => false),
}))
vi.mock('@quackback/ids', () => ({ generateId: vi.fn(() => 'workspace_test') }))
vi.mock('@/lib/server/logger', () => ({
  logger: { child: () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}))
vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      principal: { findFirst: hoisted.principalFindFirst },
      postStatuses: { findFirst: hoisted.postStatusesFindFirst },
    },
    update: hoisted.dbUpdate,
    insert: hoisted.dbInsert,
    execute: hoisted.dbExecute,
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: { principal: { findFirst: hoisted.principalFindFirst } },
        execute: hoisted.dbExecute,
      })
    ),
  },
  settings: {},
  principal: { userId: 'userId', role: 'role', type: 'type' },
  user: {},
  postStatuses: {},
  eq: vi.fn((column, value) => ({ column, value })),
  sql: vi.fn(() => ({})),
  and: vi.fn((...conditions) => conditions),
  USE_CASE_TYPES: [
    'product_feedback',
    'customer_support',
    'help_center',
    'internal',
    'saas',
    'consumer',
    'marketplace',
  ],
  DEFAULT_STATUSES: [],
}))

import { saveUseCaseFn } from '../onboarding'

/** Settings row mid-onboarding: useCase step reachable, workspace pending. */
const pendingWorkspaceSettings = {
  id: 'workspace_1',
  setupState: JSON.stringify({
    version: 1,
    steps: { core: true, workspace: false, boards: false },
  }),
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.getSession.mockResolvedValue({ user: { id: 'user_caller' } })
  hoisted.dbUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
  })
  hoisted.dbInsert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) })
})

describe('saveUseCaseFn admin promotion gate', () => {
  it('rejects a non-admin caller once a human admin exists, without writing useCase', async () => {
    hoisted.getSettings.mockResolvedValue(pendingWorkspaceSettings)
    hoisted.principalFindFirst
      .mockResolvedValueOnce({ id: 'p_caller', role: 'user' }) // caller's principal
      .mockResolvedValueOnce({ id: 'p_admin', role: 'admin', type: 'user' }) // existing admin

    await expect(saveUseCaseFn({ data: { useCase: 'product_feedback' } })).rejects.toThrow(
      /already claimed by an admin/
    )

    expect(hoisted.ensurePrincipalForUser).not.toHaveBeenCalled()
    expect(hoisted.setPrincipalRole).not.toHaveBeenCalled()
    expect(hoisted.dbUpdate).not.toHaveBeenCalled()
    expect(hoisted.dbInsert).not.toHaveBeenCalled()
  })

  it('bootstraps the first user as admin on a fresh install', async () => {
    hoisted.getSettings.mockResolvedValue(undefined)
    hoisted.principalFindFirst
      .mockResolvedValueOnce(undefined) // caller has no principal yet
      .mockResolvedValueOnce(undefined) // no human admin exists
    hoisted.ensurePrincipalForUser.mockResolvedValue({
      created: true,
      principal: { role: 'admin' },
    })

    await expect(saveUseCaseFn({ data: { useCase: 'product_feedback' } })).resolves.toBeUndefined()

    expect(hoisted.ensurePrincipalForUser).toHaveBeenCalledWith(
      { userId: 'user_caller', role: 'admin' },
      expect.any(Object)
    )
    expect(hoisted.dbInsert).toHaveBeenCalled()
  })

  it('promotes an existing non-admin principal while no human admin exists', async () => {
    hoisted.getSettings.mockResolvedValue(pendingWorkspaceSettings)
    hoisted.principalFindFirst
      .mockResolvedValueOnce({ id: 'p_caller', role: 'user' })
      .mockResolvedValueOnce(undefined) // no human admin exists
    hoisted.ensurePrincipalForUser.mockResolvedValue({
      created: false,
      principal: { role: 'user' },
    })

    await expect(saveUseCaseFn({ data: { useCase: 'internal' } })).resolves.toBeUndefined()

    expect(hoisted.setPrincipalRole).toHaveBeenCalledWith(
      { userId: 'user_caller' },
      'admin',
      expect.objectContaining({ executor: expect.any(Object), knownUserId: 'user_caller' })
    )
    expect(hoisted.dbUpdate).toHaveBeenCalled()
  })

  it('lets an existing admin through without touching promotion machinery', async () => {
    hoisted.getSettings.mockResolvedValue(pendingWorkspaceSettings)
    hoisted.principalFindFirst.mockResolvedValueOnce({ id: 'p_caller', role: 'admin' })

    await expect(saveUseCaseFn({ data: { useCase: 'help_center' } })).resolves.toBeUndefined()

    expect(hoisted.ensurePrincipalForUser).not.toHaveBeenCalled()
    expect(hoisted.principalFindFirst).toHaveBeenCalledTimes(1)
    expect(hoisted.dbUpdate).toHaveBeenCalled()
  })
})
