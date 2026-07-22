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

/**
 * GET a GitHub API URL, honoring rate limits (429 / 403 with a reset or
 * Retry-After — wait the full window, capped at 60s) and retrying transient
 * 5xx/network errors. Rate-limit waits don't consume the retry budget.
 */
async function ghGet(url: string, accessToken: string): Promise<Response> {
  const maxAttempts = 4
  let attempt = 0
  while (true) {
    let response: Response
    try {
      response = await fetch(url, { headers: HEADERS(accessToken) })
    } catch (err) {
      if (++attempt >= maxAttempts) throw err instanceof Error ? err : new Error(String(err))
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      continue
    }

    const remaining = response.headers.get('X-RateLimit-Remaining')
    const retryAfter = response.headers.get('Retry-After')
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 && (remaining === '0' || retryAfter != null))
    if (rateLimited) {
      let waitMs: number
      if (retryAfter != null) waitMs = Number(retryAfter) * 1000
      else {
        const reset = Number(response.headers.get('X-RateLimit-Reset') ?? '0') * 1000
        waitMs = Math.max(0, reset - Date.now()) + 1000
      }
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 60_000)))
      continue
    }

    if (response.status >= 500 && ++attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      continue
    }

    return response
  }
}

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
  const response = await ghGet(url, accessToken)

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
    const response = await ghGet(url, accessToken)
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
