/**
 * Snooze-wake sweeper — a per-minute repeatable job that reopens snoozed
 * conversations whose wake timer has elapsed (see sweepDueSnoozedConversations),
 * publishing the same realtime/inbox updates a manual reopen does.
 */
import { Queue, Worker } from 'bullmq'
import { getQueueRedis, REDIS_READY_TIMEOUT_MS } from '@/lib/server/queue/redis-config'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'snooze-sweep-queue' })

const QUEUE_NAME = '{snooze-sweep}'
const CONCURRENCY = 1

interface SnoozeSweepJob {
  type: 'wake-due-snoozed'
}

let initPromise: Promise<{
  queue: Queue<SnoozeSweepJob>
  worker: Worker<SnoozeSweepJob>
}> | null = null

async function initializeQueue() {
  const connection = getQueueRedis()

  const queue = new Queue<SnoozeSweepJob>(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential' as const, delay: 5000 },
      removeOnComplete: { count: 100, age: 7 * 86400 },
      removeOnFail: { age: 7 * 86400 },
    },
  })

  const worker = new Worker<SnoozeSweepJob>(
    QUEUE_NAME,
    async (job) => {
      if (job.data.type === 'wake-due-snoozed') {
        const { sweepDueSnoozedConversations } = await import('./conversation.service')
        const result = await sweepDueSnoozedConversations()
        if (result.woken > 0) {
          log.debug({ woken: result.woken }, 'snooze-sweep run complete')
        }
      }
    },
    { connection, concurrency: CONCURRENCY }
  )

  // Every minute. Stable jobId so worker reboots dedupe instead of stacking
  // duplicate cron entries.
  await queue.add(
    'snooze-sweep:minutely',
    { type: 'wake-due-snoozed' },
    {
      jobId: 'snooze-sweep:minutely',
      repeat: { pattern: '* * * * *' },
      removeOnComplete: { count: 100 },
      removeOnFail: { age: 7 * 86400 },
    }
  )

  try {
    await Promise.race([
      queue.waitUntilReady(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Redis connection timeout (5s)')), REDIS_READY_TIMEOUT_MS)
      ),
    ])
  } catch (error) {
    await queue.close().catch(() => {})
    await worker.close().catch(() => {})
    throw error
  }

  worker.on('failed', (job, error) => {
    if (!job) return
    const isPermanent =
      job.attemptsMade >= (job.opts.attempts ?? 1) || error.name === 'UnrecoverableError'
    const prefix = isPermanent ? 'permanently failed' : `failed (attempt ${job.attemptsMade})`
    log.error({ err: error, status: prefix }, 'snooze-sweep job failed')
  })

  return { queue, worker }
}

/** Initialize the snooze-sweep worker eagerly (called from startup). */
export async function initSnoozeSweepWorker(): Promise<void> {
  if (!initPromise) {
    initPromise = initializeQueue().catch((err) => {
      initPromise = null
      throw err
    })
  }
  await initPromise
  log.info('snooze-sweep worker initialized')
}

export async function closeSnoozeSweepQueue(): Promise<void> {
  if (!initPromise) return
  const { worker, queue } = await initPromise
  initPromise = null
  await worker.close().catch(() => {})
  await queue.close().catch(() => {})
}
