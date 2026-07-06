/**
 * usePortalPermissions: the portal counterpart to the admin-side
 * usePermission hook. The permission set is resolved server-side (the
 * _portal loader calls getMyPortalPermissionsFn once per request) and
 * provided here via context, so it is SSR-consistent — no flash of team UI —
 * and correct for custom roles, which a client-side preset expansion is not.
 *
 * Render-only: this decides what UI to show. The server independently
 * enforces every mutation via requireAuth({ permission }).
 *
 * Customer view: a team member can flip the whole portal into a preview of
 * exactly what an end user sees. While active, usePortalPermissions() returns
 * the frozen empty set, so EVERY permission-gated affordance disappears
 * automatically — current and future — without each call site opting in. The
 * REAL set is kept alongside so useCustomerView() can still tell whether the
 * actor is a team member (`available`) even while their effective set reads
 * empty. State is per-tab (sessionStorage) and client-only.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { PermissionKey } from '@/lib/shared/permissions'

const EMPTY_PERMISSIONS: ReadonlySet<string> = new Set()

/** Per-tab flag so a reload keeps the preview but a new tab starts as team UI. */
const CUSTOMER_VIEW_STORAGE_KEY = 'qb.portal.customerView'

// Default is the empty set so the hook is safe anywhere: outside the portal
// tree (or on the access-gate branch, which mounts no provider) every check
// simply reads false.
const PortalPermissionsContext = createContext<ReadonlySet<string>>(EMPTY_PERMISSIONS)

export interface CustomerView {
  /** True while the team member is previewing the portal as an end user. */
  active: boolean
  /**
   * True iff the actor's REAL (unsuppressed) permission set is non-empty —
   * i.e. they hold at least one management key and so are a team member for
   * whom the preview toggle is meaningful. Deliberately reflects the real set,
   * not the effective one, so the toggle keeps working while suppressed.
   */
  available: boolean
  /** Flip between team UI and the customer preview (per-tab, persisted). */
  toggle: () => void
}

const CustomerViewContext = createContext<CustomerView>({
  active: false,
  available: false,
  toggle: () => {},
})

export function PortalPermissionsProvider(props: {
  permissionKeys: ReadonlyArray<string>
  children: ReactNode
}): React.ReactElement {
  // The REAL set, always reflecting the server-resolved keys.
  const realPermissions = useMemo<ReadonlySet<string>>(
    () => (props.permissionKeys.length > 0 ? new Set(props.permissionKeys) : EMPTY_PERMISSIONS),
    [props.permissionKeys]
  )

  // SSR-safe: always start inactive on the server and the first client render
  // so hydration matches, then adopt the persisted per-tab value in an effect.
  // A brief flash of team UI on reload while in customer view is acceptable and
  // expected — it avoids a hydration mismatch.
  const [active, setActive] = useState(false)

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(CUSTOMER_VIEW_STORAGE_KEY) === '1') {
        setActive(true)
      }
    } catch {
      // sessionStorage can throw (privacy mode, disabled storage); stay inactive.
    }
  }, [])

  // Only a team member (non-empty real set) can meaningfully preview.
  const available = realPermissions.size > 0

  const toggle = useCallback(() => {
    setActive((prev) => {
      const next = !prev
      try {
        if (next) {
          window.sessionStorage.setItem(CUSTOMER_VIEW_STORAGE_KEY, '1')
        } else {
          window.sessionStorage.removeItem(CUSTOMER_VIEW_STORAGE_KEY)
        }
      } catch {
        // Ignore storage failures; the in-memory toggle still works this tab.
      }
      return next
    })
  }, [])

  // The EFFECTIVE set the rest of the portal sees: empty while previewing.
  const effectivePermissions = active ? EMPTY_PERMISSIONS : realPermissions

  const customerView = useMemo<CustomerView>(
    () => ({ active: available && active, available, toggle }),
    [available, active, toggle]
  )

  return createElement(
    PortalPermissionsContext.Provider,
    { value: effectivePermissions },
    createElement(CustomerViewContext.Provider, { value: customerView }, props.children)
  )
}

export interface PortalPermissions {
  /** The actor's resolved permission keys; empty for end users and visitors. */
  permissions: ReadonlySet<string>
  /** True when the actor holds the given permission key. */
  can: (key: PermissionKey) => boolean
  /** True when the actor holds at least one of the given keys. */
  hasAny: (...keys: PermissionKey[]) => boolean
}

export function usePortalPermissions(): PortalPermissions {
  const permissions = useContext(PortalPermissionsContext)
  return useMemo(
    () => ({
      permissions,
      can: (key: PermissionKey) => permissions.has(key),
      hasAny: (...keys: PermissionKey[]) => keys.some((key) => permissions.has(key)),
    }),
    [permissions]
  )
}

/**
 * Customer-view control, resolved from the REAL permission set so it keeps
 * working while usePortalPermissions() is suppressed to the empty set. Safe to
 * call outside a provider (returns an inert, unavailable control).
 */
export function useCustomerView(): CustomerView {
  return useContext(CustomerViewContext)
}
