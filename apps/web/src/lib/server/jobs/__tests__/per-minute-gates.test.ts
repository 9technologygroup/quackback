/**
 * Every per-minute schedule is gated.
 *
 * On a pooled fleet a schedule runs in every awake workspace. An ungated
 * `* * * * *` job is an enqueue, a claim and a run in each of them every minute,
 * whether or not the workspace has anything for it to do. `deadlines.ts` is the
 * mechanism that lets a per-minute schedule tick only when it has work.
 */
import { describe, expect, it } from 'vitest'
import { JOB_DEFINITIONS } from '../definitions'

describe('the job registry', () => {
  it('gives every per-minute schedule a gate', () => {
    const ungated = JOB_DEFINITIONS.filter(
      (def) => def.cron === '* * * * *' && !def.cronEnabled
    ).map((def) => def.name)
    expect(ungated).toEqual([])
  })
})
