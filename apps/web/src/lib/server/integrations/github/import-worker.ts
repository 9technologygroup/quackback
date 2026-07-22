/**
 * GitHub import worker — creates posts + comments from a reviewed page of issues.
 *
 * Reuses the same primitives as the live webhook so imports stay consistent and
 * loop-free: the reporter resolver (real-if-linked else synthetic), a team-role
 * actor to bypass the board submit gate, `skipDispatch: true` to avoid firing
 * the outbound hook (no new GitHub issues created), and post_external_links for
 * idempotency (already-linked issues are skipped).
 */

import type { Job } from 'bullmq'
import { db, integrations, postExternalLinks, eq, and } from '@/lib/server/db'
import { decryptSecrets } from '../encryption'
import { resolveGitHubReporterPrincipal } from './reporter-resolver'
import { listGitHubIssueComments } from './issues'
import { createPost } from '@/lib/server/domains/posts/post.service'
import { createComment } from '@/lib/server/domains/comments/comment.service'
import { linkTicketToPost } from '../apps/service'
import { addPostToRoadmap } from '@/lib/server/domains/roadmaps/roadmap.service'
import type { GitHubImportJobData, GitHubImportProgress } from './import-queue'
import type { Actor } from '@/lib/server/policy/types'
import type {
  BoardId,
  StatusId,
  TagId,
  PostId,
  RoadmapId,
  IntegrationId,
  PrincipalId,
} from '@quackback/ids'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'github-import-worker' })

/** Team-role service actor — bypasses the board submit gate + moderation. */
function teamActor(principalId: PrincipalId): Actor {
  return { principalId, role: 'member', principalType: 'service', segmentIds: new Set() }
}

export async function processGitHubImportJob(
  job: Job<GitHubImportJobData>
): Promise<GitHubImportProgress> {
  const { integrationId, rows } = job.data
  const progress: GitHubImportProgress = {
    total: rows.length,
    done: 0,
    imported: 0,
    skipped: 0,
    errors: 0,
  }

  const integration = await db.query.integrations.findFirst({
    where: eq(integrations.id, integrationId as IntegrationId),
  })
  if (!integration?.secrets) {
    throw new Error('GitHub integration not found or missing credentials')
  }
  const { accessToken } = decryptSecrets<{ accessToken: string }>(integration.secrets)
  const ownerRepo = (integration.config as Record<string, unknown> | null)?.channelId as
    | string
    | undefined
  if (!ownerRepo) throw new Error('GitHub integration has no repository configured')

  for (const row of rows) {
    const externalId = String(row.number)
    try {
      // Idempotency: skip issues already linked to a post.
      const existing = await db.query.postExternalLinks.findFirst({
        where: and(
          eq(postExternalLinks.integrationType, 'github'),
          eq(postExternalLinks.externalId, externalId)
        ),
        columns: { id: true },
      })
      if (existing) {
        progress.skipped++
        continue
      }

      const authorPrincipalId = await resolveGitHubReporterPrincipal({
        githubId: row.authorId,
        login: row.authorLogin ?? 'ghost',
        name: row.authorLogin,
      })

      const created = await createPost(
        {
          boardId: row.boardId as BoardId,
          title: row.title.slice(0, 200),
          content: (row.body ?? '').slice(0, 10000),
          statusId: row.statusId ? (row.statusId as StatusId) : undefined,
          tagIds: row.tagIds.map((t) => t as TagId),
          createdAt: new Date(row.createdAt),
        },
        { principalId: authorPrincipalId, actor: teamActor(authorPrincipalId) },
        { skipDispatch: true }
      )

      await linkTicketToPost(
        {
          postId: created.id as PostId,
          integrationId: integration.id,
          integrationType: 'github',
          externalId,
          externalUrl: row.url,
        },
        authorPrincipalId
      )

      if (row.roadmapId) {
        await addPostToRoadmap(
          { roadmapId: row.roadmapId as RoadmapId, postId: created.id as PostId },
          authorPrincipalId
        )
      }

      // Import the issue's comments (skip the fetch when there are none).
      if ((row.comments ?? 1) > 0) {
        const comments = await listGitHubIssueComments(accessToken, ownerRepo, row.number)
        for (const c of comments) {
          // Each comment is isolated: one bad comment must not error the whole
          // issue, or a re-run would skip the (now-linked) issue and lose the rest.
          try {
            const cLogin = c.user?.login ?? 'ghost'
            const commenterPrincipal = await resolveGitHubReporterPrincipal({
              githubId: c.user?.id ?? null,
              login: cLogin,
              name: cLogin,
            })
            await createComment(
              {
                postId: created.id as PostId,
                content: (c.body ?? '').slice(0, 5000),
                createdAt: new Date(c.created_at),
              },
              { principalId: commenterPrincipal, role: 'user' },
              teamActor(commenterPrincipal),
              { skipDispatch: true }
            )
          } catch (commentErr) {
            log.warn(
              { err: commentErr, issue: row.number, comment_id: c.id },
              'failed to import a comment; continuing'
            )
          }
        }
      }

      progress.imported++
    } catch (err) {
      progress.errors++
      log.error({ err, issue: row.number }, 'failed to import GitHub issue')
    } finally {
      progress.done++
      await job.updateProgress(progress as unknown as Record<string, number>)
    }
  }

  log.info(
    {
      integration_id: integrationId,
      imported: progress.imported,
      skipped: progress.skipped,
      errors: progress.errors,
    },
    'github import job complete'
  )
  return progress
}
