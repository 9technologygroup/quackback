/**
 * GitHub adapter
 *
 * Fetches issues (open + closed, pull requests excluded), their comments, and
 * releases from the GitHub REST API and converts them to the intermediate
 * import format.
 *
 * Mapping:
 *   - issue          → post (board routed by label, status from state/reason,
 *                      labels → tags, created_at preserved, external link kept)
 *   - issue comment  → comment (threading is flat; GitHub issue comments have
 *                      no parent/child structure)
 *   - release        → changelog entry (published_at preserved)
 *   - author/commenter login → synthetic portal user (login@users.noreply…)
 */

import { GitHubClient } from './client'
import type { GitHubIssue, GitHubComment, GitHubRelease } from './client'
import type {
  IntermediateData,
  IntermediatePost,
  IntermediateComment,
  IntermediateUser,
  IntermediateChangelog,
} from '../../schema/types'
import { syntheticEmail, routeBoard, mapStatus, labelNames } from './field-map'

export interface GitHubAdapterOptions {
  /** Repository in "owner/repo" form. */
  repo: string
  /** GitHub API token (needs `repo` read scope for private repos). */
  token: string
  /** Delay between API requests in ms (default: 100). */
  delayMs?: number
  verbose?: boolean
}

export interface GitHubAdapterStats {
  issues: number
  pullRequestsSkipped: number
  comments: number
  releases: number
  users: number
}

export interface GitHubAdapterResult {
  data: IntermediateData
  stats: GitHubAdapterStats
}

/**
 * Fetch all data from the GitHub REST API and convert to intermediate format.
 */
export async function convertGitHub(options: GitHubAdapterOptions): Promise<GitHubAdapterResult> {
  const log = options.verbose ? console.log.bind(console) : () => {}

  const [owner, repo] = options.repo.split('/')
  if (!owner || !repo) {
    throw new Error(`--repo must be in "owner/repo" form, got "${options.repo}"`)
  }

  const client = new GitHubClient({ token: options.token, delayMs: options.delayMs })

  const posts: IntermediatePost[] = []
  const comments: IntermediateComment[] = []
  const users = new Map<string, IntermediateUser>()

  const rememberUser = (login: string | undefined, createdAt: string) => {
    if (login && !users.has(login)) {
      users.set(login, { email: syntheticEmail(login), name: login, createdAt })
    }
  }

  // ── Issues (open + closed, PRs excluded) ───────────────────────
  log(`   Fetching issues from ${owner}/${repo}...`)
  const issues = await client.listAll<GitHubIssue>(
    `/repos/${owner}/${repo}/issues?state=all&sort=created&direction=asc`
  )
  log(`   Fetched ${issues.length} issues (incl. PRs)`)

  let pullRequestsSkipped = 0

  for (const issue of issues) {
    // GitHub's issues endpoint also returns pull requests — skip them.
    if (issue.pull_request) {
      pullRequestsSkipped++
      continue
    }

    const labels = labelNames(issue.labels)
    const login = issue.user?.login
    rememberUser(login, issue.created_at)

    posts.push({
      id: String(issue.number),
      title: issue.title || `Issue #${issue.number}`,
      body: issue.body || '',
      authorEmail: login ? syntheticEmail(login) : undefined,
      authorName: login,
      board: routeBoard(labels),
      status: mapStatus(issue.state, issue.state_reason),
      moderation: 'published',
      tags: labels.length > 0 ? labels.join(', ') : undefined,
      createdAt: issue.created_at,
      externalLink: { integrationType: 'github', externalUrl: issue.html_url },
    })

    // Issue comments (only fetched when the issue has any).
    if (issue.comments > 0) {
      const issueComments = await client.listAll<GitHubComment>(
        `/repos/${owner}/${repo}/issues/${issue.number}/comments`
      )
      for (const c of issueComments) {
        const clogin = c.user?.login
        rememberUser(clogin, c.created_at)
        comments.push({
          postId: String(issue.number),
          authorEmail: clogin ? syntheticEmail(clogin) : undefined,
          authorName: clogin,
          body: c.body || '',
          isStaff: false,
          createdAt: c.created_at,
        })
      }
    }

    if (options.verbose && posts.length % 100 === 0) {
      log(`   Converted ${posts.length} issues...`)
    }
  }

  // ── Releases → changelog ───────────────────────────────────────
  log('   Fetching releases...')
  const releases = await client.listAll<GitHubRelease>(`/repos/${owner}/${repo}/releases`)
  const changelogs: IntermediateChangelog[] = releases
    .filter((r) => !r.draft)
    .map((r) => ({
      id: r.tag_name,
      title: r.name || r.tag_name,
      body: r.body || '',
      publishedAt: r.published_at || r.created_at,
      createdAt: r.created_at,
      linkedPostIds: [],
    }))
  log(`   Converted ${changelogs.length} releases`)

  const data: IntermediateData = {
    posts,
    comments,
    votes: [],
    notes: [],
    users: [...users.values()],
    changelogs,
  }

  return {
    data,
    stats: {
      issues: posts.length,
      pullRequestsSkipped,
      comments: comments.length,
      releases: changelogs.length,
      users: users.size,
    },
  }
}

export function printStats(stats: GitHubAdapterStats): void {
  console.log('\n📊 GitHub conversion stats:')
  console.log(`   Issues:        ${stats.issues}`)
  console.log(`   PRs skipped:   ${stats.pullRequestsSkipped}`)
  console.log(`   Comments:      ${stats.comments}`)
  console.log(`   Releases:      ${stats.releases}`)
  console.log(`   Users:         ${stats.users}`)
}
