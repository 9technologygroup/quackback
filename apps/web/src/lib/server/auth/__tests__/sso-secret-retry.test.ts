import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  scheduleSsoSecretRetry,
  _cancelSsoSecretRetry,
  _ssoSecretRetryMsForTests,
} from '../sso-secret-retry'

interface FakeTimer {
  fn: () => void
  ms: number
  unref: () => void
}

function makeDeps(initial: { secret?: string } = {}) {
  let secret = initial.secret
  const timers: FakeTimer[] = []
  const resetAuth = vi.fn()
  const log = vi.fn()
  const deps = {
    getSecret: () => secret,
    resetAuth,
    schedule: vi.fn((fn: () => void, ms: number) => {
      const t: FakeTimer = { fn, ms, unref: vi.fn() }
      timers.push(t)
      return t
    }),
    cancel: vi.fn((h: unknown) => {
      const idx = timers.findIndex((t) => t === h)
      if (idx >= 0) timers.splice(idx, 1)
    }),
    log,
  }
  return {
    deps,
    timers,
    resetAuth,
    log,
    setSecret: (next: string | undefined) => {
      secret = next
    },
    fireAllPending: () => {
      const pending = timers.splice(0)
      for (const t of pending) t.fn()
    },
  }
}

describe('scheduleSsoSecretRetry', () => {
  beforeEach(() => {
    // Drain the module-level _activeHandle between tests by cancelling.
    _cancelSsoSecretRetry({ cancel: () => {} })
  })

  afterEach(() => {
    _cancelSsoSecretRetry({ cancel: () => {} })
  })

  it('schedules a single retry after the configured delay', () => {
    const h = makeDeps()
    scheduleSsoSecretRetry(h.deps)
    expect(h.deps.schedule).toHaveBeenCalledTimes(1)
    expect(h.deps.schedule.mock.calls[0]?.[1]).toBe(_ssoSecretRetryMsForTests)
  })

  it('coalesces overlapping retries into a single in-flight timer', () => {
    const h = makeDeps()
    scheduleSsoSecretRetry(h.deps)
    scheduleSsoSecretRetry(h.deps)
    scheduleSsoSecretRetry(h.deps)
    expect(h.deps.schedule).toHaveBeenCalledTimes(1)
  })

  it('calls resetAuth when the secret has materialised by the time the timer fires', () => {
    const h = makeDeps({ secret: undefined })
    scheduleSsoSecretRetry(h.deps)
    expect(h.resetAuth).not.toHaveBeenCalled()
    h.setSecret('late-arriving-secret')
    h.fireAllPending()
    expect(h.resetAuth).toHaveBeenCalledTimes(1)
    expect(h.log).toHaveBeenCalledWith(
      expect.stringContaining('SSO_OIDC_CLIENT_SECRET materialized')
    )
  })

  it('does NOT call resetAuth when the secret is still missing at fire time', () => {
    const h = makeDeps({ secret: undefined })
    scheduleSsoSecretRetry(h.deps)
    h.fireAllPending()
    expect(h.resetAuth).not.toHaveBeenCalled()
    expect(h.log).not.toHaveBeenCalled()
  })

  it('re-arms the timer when the secret is still missing at fire time', () => {
    const h = makeDeps({ secret: undefined })
    scheduleSsoSecretRetry(h.deps)
    expect(h.deps.schedule).toHaveBeenCalledTimes(1)
    h.fireAllPending()
    // The cached _auth instance never re-enters createAuth() on its
    // own, so the retry has to keep itself going until the secret
    // shows up.
    expect(h.deps.schedule).toHaveBeenCalledTimes(2)
    expect(h.resetAuth).not.toHaveBeenCalled()
  })

  it('stops re-arming after the secret materialises', () => {
    const h = makeDeps({ secret: undefined })
    scheduleSsoSecretRetry(h.deps)
    h.fireAllPending() // first fire: secret still missing → re-arm
    expect(h.deps.schedule).toHaveBeenCalledTimes(2)
    h.setSecret('arrived')
    h.fireAllPending() // second fire: secret found → resetAuth, no re-arm
    expect(h.resetAuth).toHaveBeenCalledTimes(1)
    expect(h.deps.schedule).toHaveBeenCalledTimes(2)
  })

  it('allows a fresh retry to be scheduled after the previous one fires', () => {
    const h = makeDeps({ secret: 'present' })
    scheduleSsoSecretRetry(h.deps)
    h.fireAllPending() // secret was present → resetAuth, no re-arm
    // First retry consumed; a subsequent createAuth() that finds the
    // secret missing again should be able to queue another.
    h.setSecret(undefined)
    scheduleSsoSecretRetry(h.deps)
    expect(h.deps.schedule).toHaveBeenCalledTimes(2)
  })

  it('unrefs the timer so the Node event loop is not held open', () => {
    const h = makeDeps()
    scheduleSsoSecretRetry(h.deps)
    expect(h.timers[0]?.unref).toHaveBeenCalledTimes(1)
  })
})
