/**
 * GitHub issue + comment listing for the in-app import wizard.
 *
 * Uses the integration's stored OAuth token. Modeled on repos.ts (same auth
 * headers / base URL). The list endpoint returns pull requests too, so callers
 * filter them out via the `pull_request` field.
 */

const GITHUB_API = 'https://api.github.com'

const HEADERS = (accessToken: string) => ({
  Authorization: `Bearer ${accessToken}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'quackback',
  'X-GitHub-Api-Version': '2022-11-28',
})

export interface GitHubIssueUser {
  id: number
  login: string
}

export interface GitHubIssueRaw {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  state_reason: string | null
  html_url: string
  created_at: string
  user: GitHubIssueUser | null
  labels: Array<{ name: string } | string>
  milestone: { title: string } | null
  pull_request?: unknown
  comments: number
}

export interface GitHubIssueCommentRaw {
  id: number
  body: string | null
  created_at: string
  user: GitHubIssueUser | null
}

export interface GitHubIssuesPage {
  issues: GitHubIssueRaw[]
  /** True when GitHub reports another page (raw batch, before PR filtering). */
  hasNextPage: boolean
}

/**
 * Fetch one page of issues (open + closed), with pull requests filtered out.
 * `hasNextPage` is inferred from the raw batch size so PR filtering doesn't
 * make the last page look empty.
 */
export async function listGitHubIssues(
  accessToken: string,
  ownerRepo: string,
  page: number,
  perPage: number
): Promise<GitHubIssuesPage> {
  const url = `${GITHUB_API}/repos/${ownerRepo}/issues?state=all&sort=created&direction=asc&per_page=${perPage}&page=${page}`
  const response = await fetch(url, { headers: HEADERS(accessToken) })

  if (!response.ok) {
    throw new Error(`Failed to list GitHub issues: HTTP ${response.status}`)
  }

  const raw = (await response.json()) as GitHubIssueRaw[]
  return {
    issues: raw.filter((issue) => !issue.pull_request),
    hasNextPage: raw.length === perPage,
  }
}

/**
 * Fetch all comments for a single issue (paginated internally).
 */
export async function listGitHubIssueComments(
  accessToken: string,
  ownerRepo: string,
  issueNumber: number
): Promise<GitHubIssueCommentRaw[]> {
  const comments: GitHubIssueCommentRaw[] = []
  const perPage = 100
  let page = 1

  while (true) {
    const url = `${GITHUB_API}/repos/${ownerRepo}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page}`
    const response = await fetch(url, { headers: HEADERS(accessToken) })
    if (!response.ok) {
      throw new Error(
        `Failed to list comments for issue #${issueNumber}: HTTP ${response.status}`
      )
    }
    const batch = (await response.json()) as GitHubIssueCommentRaw[]
    if (batch.length === 0) break
    comments.push(...batch)
    if (batch.length < perPage) break
    page++
  }

  return comments
}

/** Extract label names (objects or bare strings), dropping comma-containing ones. */
export function issueLabelNames(labels: Array<{ name: string } | string>): string[] {
  return labels
    .map((l) => (typeof l === 'string' ? l : l.name))
    .filter((n) => n && !n.includes(','))
}
