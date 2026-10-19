/**
 * Retry timing for jobs that fail together.
 *
 * A database restart fails every running job in the fleet at the same moment.
 * On a fixed curve they all retry at the same moment too, and meet the same
 * overload again.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RETRY_BACKOFF_MS,
  findJobDefinition,
  retryBackoffMs,
  type JobDefinition,
} from '../definitions'

const plain: JobDefinition = { name: 'plain', handler: async () => async () => {} }

describe('the default retry curve', () => {
  it('never retries sooner than the doubling curve', () => {
    for (const attempt of [1, 2, 3]) {
      const curve = DEFAULT_RETRY_BACKOFF_MS * 2 ** (attempt - 1)
      expect(retryBackoffMs(plain, attempt, () => 0)).toBe(curve)
    }
  })

  it('spreads jobs that failed together across half the delay again', () => {
    const delays = [0, 0.25, 0.5, 0.75, 0.999].map((r) => retryBackoffMs(plain, 2, () => r))
    const curve = DEFAULT_RETRY_BACKOFF_MS * 2
    expect(new Set(delays).size).toBe(delays.length)
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(curve)
      expect(delay).toBeLessThan(curve * 1.5)
    }
  })

  it('leaves a queue with its own curve on that curve', () => {
    const own: JobDefinition = { ...plain, backoffMs: (n) => n * 1_000 }
    expect(retryBackoffMs(own, 3, () => 0)).toBe(3_000)
    expect(retryBackoffMs(own, 3, () => 0.9)).toBe(3_000)
  })
})

describe('the analytics refresh', () => {
  it('retries after a database restart has had time to finish, not during it', () => {
    // A crash recovery takes about two minutes. Five and ten seconds land inside
    // it, so every retry fails and the attempts are spent before the database is
    // back; the next hourly slot covers anything a late retry misses.
    const def = findJobDefinition('analytics')
    expect(def).toBeDefined()
    expect(retryBackoffMs(def!, 1, () => 0)).toBeGreaterThanOrEqual(60_000)
  })
})
