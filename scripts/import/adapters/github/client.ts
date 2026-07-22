/**
 * GitHub REST API client for the import adapter.
 *
 * Handles token auth, page-based pagination, rate limiting, and retry with
 * exponential backoff. Authenticated requests get 5000 req/hr; a token is
 * required (unauthenticated is 60/hr and will not complete a full repo).
 */

const BASE_URL = 'https://api.github.com'

export interface GitHubClientOptions {
  token: string
  /** Delay between requests in ms (default: 100) */
  delayMs?: number
}

export interface GitHubUser {
  id: number
  login: string
  name?: string | null
}

export interface GitHubIssue {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  state_reason?: string | null
  html_url: string
  created_at: string
  user: GitHubUser | null
  labels: Array<{ name: string } | string>
  /** Present only when the "issue" is actually a pull request. */
  pull_request?: unknown
  comments: number
}

export interface GitHubComment {
  id: number
  body: string | null
  html_url: string
  created_at: string
  user: GitHubUser | null
}

export interface GitHubRelease {
  id: number
  tag_name: string
  name: string | null
  body: string | null
  draft: boolean
  published_at: string | null
  created_at: string
}

export class GitHubClient {
  private token: string
  private delayMs: number
  private lastRequestAt = 0

  constructor(options: GitHubClientOptions) {
    this.token = options.token
    this.delayMs = options.delayMs ?? 100
  }

  /**
   * Fetch a single page. `path` may already contain a query string.
   *
   * Rate-limit waits (429, or 403 with a reset/Retry-After) sleep the FULL
   * window and do NOT consume the retry budget — a real reset can be up to an
   * hour away and must not abort the run. Transient failures (5xx, network
   * errors) are retried with exponential backoff up to `maxAttempts`; 4xx
   * (other than rate limits) throw immediately.
   */
  private async get<T>(path: string): Promise<T> {
    const url = `${BASE_URL}${path}`
    const maxAttempts = 5
    let attempt = 0

    while (true) {
      await this.rateLimit()

      let response: Response
      try {
        response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'quackback-import',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        })
      } catch (err) {
        // Network-level failure — retry with backoff.
        if (++attempt >= maxAttempts) {
          throw err instanceof Error ? err : new Error(String(err))
        }
        await this.backoff(attempt)
        continue
      }

      // Rate limits: primary (remaining=0) or secondary (Retry-After present).
      const remaining = response.headers.get('X-RateLimit-Remaining')
      const retryAfter = response.headers.get('Retry-After')
      const isRateLimited =
        response.status === 429 ||
        (response.status === 403 && (remaining === '0' || retryAfter != null))
      if (isRateLimited) {
        let waitMs: number
        if (retryAfter != null) {
          waitMs = Number(retryAfter) * 1000
        } else {
          const reset = Number(response.headers.get('X-RateLimit-Reset') ?? '0') * 1000
          waitMs = Math.max(0, reset - Date.now()) + 1000
        }
        // Full wait; capped at 1h as a sanity ceiling. Does not consume retries.
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 3_600_000)))
        continue
      }

      // Transient server errors — retry.
      if (response.status >= 500) {
        if (++attempt >= maxAttempts) {
          const text = await response.text()
          throw new Error(`GitHub API error ${response.status} on ${path}: ${text}`)
        }
        await this.backoff(attempt)
        continue
      }

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`GitHub API error ${response.status} on ${path}: ${text}`)
      }

      return (await response.json()) as T
    }
  }

  private async backoff(attempt: number): Promise<void> {
    const base = Math.min(1000 * 2 ** attempt, 30_000)
    const jitter = base * (0.5 + Math.random())
    await new Promise((r) => setTimeout(r, jitter))
  }

  /**
   * Fetch all items across pages (page-based pagination). `path` may already
   * carry a query string (e.g. "?state=all"); per_page/page are appended.
   */
  async listAll<T>(path: string, perPage = 100): Promise<T[]> {
    const items: T[] = []
    let page = 1
    const sep = path.includes('?') ? '&' : '?'

    while (true) {
      const pagePath = `${path}${sep}per_page=${perPage}&page=${page}`
      const batch = await this.get<T[]>(pagePath)
      if (!Array.isArray(batch) || batch.length === 0) break
      items.push(...batch)
      if (batch.length < perPage) break
      page++
    }

    return items
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now()
    const elapsed = now - this.lastRequestAt
    if (elapsed < this.delayMs) {
      await new Promise((r) => setTimeout(r, this.delayMs - elapsed))
    }
    this.lastRequestAt = Date.now()
  }
}
