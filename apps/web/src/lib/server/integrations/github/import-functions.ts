/**
 * Server functions for the in-app GitHub issue import wizard.
 *
 * All admin-session gated (no API key) — they use the integration's stored
 * OAuth token. `fetchGitHubIssuesPage` builds the review table (issues +
 * suggested mappings + already-imported flags); `startGitHubImport` enqueues a
 * background job for a reviewed page; `getGitHubImportStatus` polls its progress.
 */

import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

export interface GitHubIssueImportRow {
  number: number
  title: string
  body: string
  url: string
  state: string
  labels: string[]
  milestone: string | null
  authorLogin: string | null
  authorId: number | null
  createdAt: string
  comments: number
  alreadyImported: boolean
  suggestedBoardId: string | null
  suggestedStatusId: string | null
  suggestedTagIds: string[]
}

export interface GitHubIssuesPageResult {
  rows: GitHubIssueImportRow[]
  page: number
  hasNextPage: boolean
}

function slugKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export const fetchGitHubIssuesPageFn = createServerFn({ method: 'GET' })
  .validator(
    (input: unknown) =>
      z.object({ page: z.number().int().min(1).default(1), perPage: z.number().int().min(1).max(100).default(50) }).parse(input)
  )
  .handler(async ({ data }): Promise<GitHubIssuesPageResult> => {
    const { requireAuth } = await import('../../functions/auth-helpers')
    const { db, integrations, postExternalLinks, eq, and, inArray } = await import('@/lib/server/db')
    const { decryptSecrets } = await import('../encryption')
    const { listGitHubIssues, issueLabelNames } = await import('./issues')
    const { suggestBoardCategory, resolveSuggestedBoardId, mapStatusSlug } = await import(
      './issue-mapping'
    )
    const { listBoards } = await import('@/lib/server/domains/boards/board.service')
    const { listStatuses } = await import('@/lib/server/domains/statuses/status.service')
    const { listTags } = await import('@/lib/server/domains/tags/tag.service')

    await requireAuth({ roles: ['admin'] })

    const integration = await db.query.integrations.findFirst({
      where: eq(integrations.integrationType, 'github'),
    })
    if (!integration?.secrets || integration.status !== 'active') {
      throw new Error('GitHub not connected')
    }
    const ownerRepo = (integration.config as Record<string, unknown> | null)?.channelId as
      | string
      | undefined
    if (!ownerRepo) throw new Error('No repository configured')

    const { accessToken } = decryptSecrets<{ accessToken: string }>(integration.secrets)
    const { issues, hasNextPage } = await listGitHubIssues(
      accessToken,
      ownerRepo,
      data.page,
      data.perPage
    )

    // Reference data for suggested mappings.
    const [boards, statuses, tags] = await Promise.all([listBoards(), listStatuses(), listTags()])
    const boardList = boards.map((b) => ({ id: b.id as string, slug: b.slug, name: b.name }))
    const statusBySlug = new Map(
      statuses.map((s) => [slugKey((s as { slug?: string }).slug ?? s.name), s.id as string])
    )
    const tagByName = new Map(tags.map((t) => [t.name.toLowerCase(), t.id as string]))

    // Batch the already-imported lookup for this page's issue numbers.
    const numbers = issues.map((i) => String(i.number))
    const links = numbers.length
      ? await db.query.postExternalLinks.findMany({
          where: and(
            eq(postExternalLinks.integrationType, 'github'),
            inArray(postExternalLinks.externalId, numbers)
          ),
          columns: { externalId: true },
        })
      : []
    const importedNumbers = new Set(links.map((l) => l.externalId))

    const rows: GitHubIssueImportRow[] = issues.map((issue) => {
      const labels = issueLabelNames(issue.labels)
      const suggestedTagIds = labels
        .map((name) => tagByName.get(name.toLowerCase()))
        .filter((id): id is string => Boolean(id))
      return {
        number: issue.number,
        title: issue.title || `Issue #${issue.number}`,
        body: issue.body || '',
        url: issue.html_url,
        state: issue.state,
        labels,
        milestone: issue.milestone?.title ?? null,
        authorLogin: issue.user?.login ?? null,
        authorId: issue.user?.id ?? null,
        createdAt: issue.created_at,
        comments: issue.comments ?? 0,
        alreadyImported: importedNumbers.has(String(issue.number)),
        suggestedBoardId: resolveSuggestedBoardId(suggestBoardCategory(labels), boardList),
        suggestedStatusId: statusBySlug.get(mapStatusSlug(issue.state, issue.state_reason)) ?? null,
        suggestedTagIds,
      }
    })

    return { rows, page: data.page, hasNextPage }
  })

const importRowSchema = z.object({
  number: z.number().int(),
  title: z.string().max(500),
  body: z.string().max(65536),
  url: z.string().url().startsWith('https://'),
  comments: z.number().int().min(0).optional(),
  authorLogin: z.string().nullable(),
  authorId: z.number().int().nullable(),
  createdAt: z.string().datetime(),
  boardId: z.string().min(1),
  statusId: z.string().optional(),
  tagIds: z.array(z.string()),
  roadmapId: z.string().optional(),
})

export const startGitHubImportFn = createServerFn({ method: 'POST' })
  .validator((input: unknown) => z.object({ rows: z.array(importRowSchema).min(1).max(100) }).parse(input))
  .handler(async ({ data }): Promise<{ jobId: string }> => {
    const { requireAuth } = await import('../../functions/auth-helpers')
    const { db, integrations, eq } = await import('@/lib/server/db')
    const { enqueueGitHubImportJob } = await import('./import-queue')

    await requireAuth({ roles: ['admin'] })

    const integration = await db.query.integrations.findFirst({
      where: eq(integrations.integrationType, 'github'),
    })
    if (!integration || integration.status !== 'active') {
      throw new Error('GitHub not connected')
    }

    const jobId = await enqueueGitHubImportJob({
      integrationId: integration.id,
      rows: data.rows,
    })
    return { jobId }
  })

export const getGitHubImportStatusFn = createServerFn({ method: 'GET' })
  .validator((input: unknown) => z.object({ jobId: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const { requireAuth } = await import('../../functions/auth-helpers')
    const { getGitHubImportJobStatus } = await import('./import-queue')
    await requireAuth({ roles: ['admin'] })
    return getGitHubImportJobStatus(data.jobId)
  })
