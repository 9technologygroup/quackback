// @vitest-environment happy-dom
/**
 * usePortalPermissions: render-only permission checks for the portal tree.
 * The set arrives from the _portal loader (server-resolved) through
 * PortalPermissionsProvider; outside any provider the hook must degrade to
 * the empty set so it is safe to call anywhere.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { PERMISSIONS } from '@/lib/shared/permissions'
import {
  PortalPermissionsProvider,
  useCustomerView,
  usePortalPermissions,
} from '../use-portal-permissions'

function withProvider(permissionKeys: string[]) {
  return ({ children }: { children: ReactNode }) =>
    createElement(PortalPermissionsProvider, { permissionKeys, children })
}

// A single hook returning both surfaces so a test can toggle customer view and
// observe the effect on the (suppressed) permission set in one render tree.
function useBoth() {
  return { perms: usePortalPermissions(), customerView: useCustomerView() }
}

describe('usePortalPermissions', () => {
  it('is empty and denies everything outside a provider', () => {
    const { result } = renderHook(() => usePortalPermissions())

    expect(result.current.permissions.size).toBe(0)
    expect(result.current.can(PERMISSIONS.POST_SET_STATUS)).toBe(false)
    expect(result.current.hasAny(PERMISSIONS.POST_SET_STATUS, PERMISSIONS.COMMENT_PIN)).toBe(false)
  })

  it('grants exactly the provided keys', () => {
    const { result } = renderHook(() => usePortalPermissions(), {
      wrapper: withProvider([PERMISSIONS.POST_SET_STATUS, PERMISSIONS.COMMENT_PIN]),
    })

    expect(result.current.permissions.size).toBe(2)
    expect(result.current.can(PERMISSIONS.POST_SET_STATUS)).toBe(true)
    expect(result.current.can(PERMISSIONS.BILLING_MANAGE)).toBe(false)
  })

  it('hasAny is true when at least one key is held', () => {
    const { result } = renderHook(() => usePortalPermissions(), {
      wrapper: withProvider([PERMISSIONS.COMMENT_PIN]),
    })

    expect(result.current.hasAny(PERMISSIONS.BILLING_MANAGE, PERMISSIONS.COMMENT_PIN)).toBe(true)
    expect(result.current.hasAny(PERMISSIONS.BILLING_MANAGE)).toBe(false)
    expect(result.current.hasAny()).toBe(false)
  })

  it('denies everything for an empty key list (end user / visitor payload)', () => {
    const { result } = renderHook(() => usePortalPermissions(), {
      wrapper: withProvider([]),
    })

    expect(result.current.permissions.size).toBe(0)
    expect(result.current.can(PERMISSIONS.POST_SET_STATUS)).toBe(false)
  })
})

describe('useCustomerView', () => {
  afterEach(() => {
    window.sessionStorage.clear()
  })

  it('is inert and unavailable outside a provider', () => {
    const { result } = renderHook(() => useCustomerView())

    expect(result.current.available).toBe(false)
    expect(result.current.active).toBe(false)
    // toggle must be a no-op that never throws off-tree.
    expect(() => result.current.toggle()).not.toThrow()
  })

  it('available reflects the REAL set: true for a team member', () => {
    const { result } = renderHook(() => useCustomerView(), {
      wrapper: withProvider([PERMISSIONS.POST_SET_STATUS]),
    })

    expect(result.current.available).toBe(true)
  })

  it('available is false for an end user (empty set)', () => {
    const { result } = renderHook(() => useCustomerView(), {
      wrapper: withProvider([]),
    })

    expect(result.current.available).toBe(false)
  })

  it('suppresses the permission set while active but keeps available true', () => {
    const { result } = renderHook(() => useBoth(), {
      wrapper: withProvider([PERMISSIONS.POST_SET_STATUS, PERMISSIONS.COMMENT_PIN]),
    })

    // Team UI visible before toggling.
    expect(result.current.perms.can(PERMISSIONS.POST_SET_STATUS)).toBe(true)
    expect(result.current.customerView.active).toBe(false)

    act(() => result.current.customerView.toggle())

    // Effective set is now empty; every gated affordance reads false.
    expect(result.current.customerView.active).toBe(true)
    expect(result.current.perms.permissions.size).toBe(0)
    expect(result.current.perms.can(PERMISSIONS.POST_SET_STATUS)).toBe(false)
    expect(result.current.perms.hasAny(PERMISSIONS.POST_SET_STATUS, PERMISSIONS.COMMENT_PIN)).toBe(
      false
    )
    // available still reflects the REAL set so the toggle can't hide itself.
    expect(result.current.customerView.available).toBe(true)
  })

  it('round-trips: toggling back restores the real permission set', () => {
    const { result } = renderHook(() => useBoth(), {
      wrapper: withProvider([PERMISSIONS.POST_SET_STATUS]),
    })

    act(() => result.current.customerView.toggle())
    expect(result.current.perms.can(PERMISSIONS.POST_SET_STATUS)).toBe(false)

    act(() => result.current.customerView.toggle())
    expect(result.current.customerView.active).toBe(false)
    expect(result.current.perms.can(PERMISSIONS.POST_SET_STATUS)).toBe(true)
  })

  it('persists the active state to sessionStorage (per-tab)', () => {
    const { result } = renderHook(() => useCustomerView(), {
      wrapper: withProvider([PERMISSIONS.POST_SET_STATUS]),
    })

    act(() => result.current.toggle())
    expect(window.sessionStorage.getItem('qb.portal.customerView')).toBe('1')

    act(() => result.current.toggle())
    expect(window.sessionStorage.getItem('qb.portal.customerView')).toBeNull()
  })
})
