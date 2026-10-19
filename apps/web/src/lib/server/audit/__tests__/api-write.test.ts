/**
 * The route an api.write row names: a REST route's own words, with ids as
 * `:id` and anything else the caller typed as `:param`, so a row never carries
 * a long or made-up path and one route always reads as one route.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { API_ROUTE_SEGMENTS, API_ROUTE_MAX_LEN, apiRoutePattern } from '../api-write'

const POST_ID = 'post_01h455vb4pex5vsknk084sn02t'
const V1_ROUTES = join(import.meta.dirname, '..', '..', '..', '..', 'routes', 'api', 'v1')

/** Every static segment of every /api/v1 route id. */
function routeSegments(dir: string): string[] {
  const segments: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (entry === '__tests__') continue
    if (statSync(path).isDirectory()) {
      segments.push(...routeSegments(path))
      continue
    }
    const id = /createFileRoute\('([^']+)'\)/.exec(readFileSync(path, 'utf8'))?.[1]
    if (!id) continue
    segments.push(...id.split('/').filter((s) => s !== '' && !s.startsWith('$')))
  }
  return segments
}

describe('apiRoutePattern', () => {
  it('keeps route words and replaces ids', () => {
    expect(apiRoutePattern(`/api/v1/posts/${POST_ID}/vote/proxy`)).toBe(
      '/api/v1/posts/:id/vote/proxy'
    )
    expect(apiRoutePattern('/api/v1/posts/0190f3a2-7b1c-7cde-8f00-1234567890ab')).toBe(
      '/api/v1/posts/:id'
    )
  })

  it('replaces any other segment, such as a slug or a made-up path, with :param', () => {
    expect(apiRoutePattern('/api/v1/segments/vip-customers/members')).toBe(
      '/api/v1/segments/:param/members'
    )
    expect(apiRoutePattern('/api/v1/posts/<script>/whatever')).toBe('/api/v1/posts/:param/:param')
  })

  it('caps the pattern, however long the path', () => {
    const pattern = apiRoutePattern(`/api/v1${'/posts'.repeat(500)}`)
    expect(pattern.length).toBeLessThanOrEqual(API_ROUTE_MAX_LEN)
    expect(pattern.startsWith('/api/v1/posts/posts')).toBe(true)
  })

  it('knows every word the REST routes use, so a real route keeps its name', () => {
    const found = [...new Set(routeSegments(V1_ROUTES))]
    // The scan really reads the routes; an empty scan would pass vacuously.
    expect(found).toEqual(expect.arrayContaining(['posts', 'comments', 'help-center']))
    const missing = found.filter((segment) => !API_ROUTE_SEGMENTS.has(segment))
    expect(missing).toEqual([])
  })
})
