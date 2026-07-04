/**
 * Durable workflow waits (support platform §4.6, Slice 5e). A 'wait' node parks a
 * run; this is the BullMQ delayed job that resumes it when the timer fires. One
 * job per wait, keyed by run id so a reboot dedupes rather than stacking. The
 * worker re-loads the run and calls resumeWorkflowRun, which itself no-ops if a
 * reply/close interrupted the run in the meantime.
 *
 * Registered in the worker registry so boot/drain manage it like every other
 * queue; it initializes lazily on the first scheduled wait.
 */
import { Queue, Worker } from 'bullmq'
import { getQueueRedis, REDIS_READY_TIMEOUT_MS } from '@/lib/server/queue/redis-config'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'workflow-wait-queue' })

const QUEUE_NAME = '{workflow-wait}'
const CONCURRENCY = 4

interface WorkflowWaitJob {
  runId: string
}

let initPromise: Promise<{
  queue: Queue<WorkflowWaitJob>
  worker: Worker<WorkflowWaitJob>
}> | null = null

async function initializeQueue() {
  const connection = getQueueRedis()

  const queue = new Queue<WorkflowWaitJob>(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential' as const, delay: 5000 },
      removeOnComplete: { count: 100, age: 7 * 86400 },
      removeOnFail: { age: 7 * 86400 },
    },
  })

  const worker = new Worker<WorkflowWaitJob>(
    QUEUE_NAME,
    async (job) => {
      const { resumeWorkflowRun } = await import('./workflow.engine')
      await resumeWorkflowRun(job.data.runId as Parameters<typeof resumeWorkflowRun>[0])
    },
    { connection, concurrency: CONCURRENCY }
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
    log.error(
      { err: error, runId: job.data.runId, permanent: isPermanent },
      'workflow-wait resume failed'
    )
  })

  return { queue, worker }
}

async function ensureQueue() {
  if (!initPromise) {
    initPromise = initializeQueue().catch((err) => {
      initPromise = null
      throw err
    })
  }
  return initPromise
}

/**
 * Schedule a run to resume after `waitSeconds`. The jobId is derived from the run
 * id so re-scheduling the same wait (e.g. after a retry) dedupes instead of
 * stacking. A zero/negative wait resumes on the next tick.
 */
export async function scheduleWorkflowResume(runId: string, waitSeconds: number): Promise<void> {
  const { queue } = await ensureQueue()
  await queue.add(
    'workflow-wait:resume',
    { runId },
    { jobId: `workflow-wait:${runId}`, delay: Math.max(0, waitSeconds) * 1000 }
  )
}

/** Eager init (called from startup via the worker registry). */
export async function initWorkflowWaitWorker(): Promise<void> {
  await ensureQueue()
  log.info('workflow-wait worker initialized')
}

export async function closeWorkflowWaitQueue(): Promise<void> {
  if (!initPromise) return
  const { worker, queue } = await initPromise
  initPromise = null
  await worker.close().catch(() => {})
  await queue.close().catch(() => {})
}
