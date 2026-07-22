/**
 * GitHub import queue — background worker for the in-app import wizard.
 *
 * A job carries one reviewed page of issues; the worker fetches each issue's
 * comments and creates posts + comments in Quackback. Runs as a job (not a
 * request) because per-issue comment fetches are slow. Mirrors the lazy-init
 * singleton pattern of feedback-ingest-queue.ts.
 */

import { Queue, Worker } from 'bullmq'
import { getQueueRedis, REDIS_READY_TIMEOUT_MS } from '@/lib/server/queue/redis-config'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'github-import-queue' })

const QUEUE_NAME = '{github-import}'
const CONCURRENCY = 1

const DEFAULT_JOB_OPTS = {
  attempts: 1, // not auto-retried — partial progress is idempotent, admin re-runs
  removeOnComplete: { count: 100, age: 86400 },
  removeOnFail: { age: 14 * 86400 },
}

/** One reviewed issue row to import. IDs are TypeID strings over the wire. */
export interface GitHubImportRow {
  number: number
  title: string
  body: string
  url: string
  authorLogin: string | null
  authorId: number | null
  createdAt: string
  boardId: string
  statusId?: string
  tagIds: string[]
  roadmapId?: string
}

export interface GitHubImportJobData {
  integrationId: string
  rows: GitHubImportRow[]
}

export interface GitHubImportProgress {
  total: number
  done: number
  imported: number
  skipped: number
  errors: number
}

let initPromise: Promise<{
  queue: Queue<GitHubImportJobData>
  worker: Worker<GitHubImportJobData>
}> | null = null

function ensureQueue(): Promise<Queue<GitHubImportJobData>> {
  if (!initPromise) {
    initPromise = initializeQueue().catch((err) => {
      initPromise = null
      throw err
    })
  }
  return initPromise.then(({ queue }) => queue)
}

async function initializeQueue() {
  const connection = getQueueRedis()

  const queue = new Queue<GitHubImportJobData>(QUEUE_NAME, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTS,
  })

  const worker = new Worker<GitHubImportJobData>(
    QUEUE_NAME,
    async (job) => {
      const { processGitHubImportJob } = await import('./import-worker')
      return processGitHubImportJob(job)
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
    log.error({ err: error, job_id: job?.id }, 'github import job failed')
  })

  return { queue, worker }
}

/** Enqueue an import job; returns the job id used to poll status. */
export async function enqueueGitHubImportJob(data: GitHubImportJobData): Promise<string> {
  const queue = await ensureQueue()
  const job = await queue.add('github-import', data)
  return job.id as string
}

export interface GitHubImportStatus {
  state: string
  progress: GitHubImportProgress | null
}

/** Read a job's state + progress for the wizard's progress bar. */
export async function getGitHubImportJobStatus(jobId: string): Promise<GitHubImportStatus | null> {
  const queue = await ensureQueue()
  const job = await queue.getJob(jobId)
  if (!job) return null
  const state = await job.getState()
  const progress =
    job.progress && typeof job.progress === 'object'
      ? (job.progress as unknown as GitHubImportProgress)
      : null
  return { state, progress }
}

export async function closeGitHubImportQueue(): Promise<void> {
  if (!initPromise) return
  const { worker, queue } = await initPromise
  initPromise = null
  await worker.close().catch(() => {})
  await queue.close().catch(() => {})
}
