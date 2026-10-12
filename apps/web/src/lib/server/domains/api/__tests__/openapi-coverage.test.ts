/**
 * Guard: every public REST route under routes/api/v1 must be documented in the
 * OpenAPI spec. The route list is derived from the route files themselves (the
 * createFileRoute path plus the exported method handlers), so a new route
 * without a matching registerPath call fails here.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const ROUTES_DIR = join(__dirname, '../../../../../routes/api/v1')
const NOT_DOCUMENTED = new Set(['openapi.json.ts', 'docs.ts'])
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name.startsWith('-')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...routeFiles(full))
    else if (name.endsWith('.ts') && !NOT_DOCUMENTED.has(relative(ROUTES_DIR, full))) {
      out.push(full)
    }
  }
  return out
}

/** `METHOD /path` in OpenAPI form, relative to the `/api/v1` server URL. */
function routeOperations(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const match = src.match(/createFileRoute\(\s*'\/api\/v1([^']*)'/)
  if (!match) throw new Error(`No createFileRoute path in ${file}`)
  const path = (match[1].replace(/\/$/, '') || '/').replace(/\$(\w+)/g, '{$1}')
  return methodsOf(file, src).map((m) => `${m} ${path}`)
}

/**
 * Methods a route file serves. Handlers are normally an inline object; alias
 * routes pass an imported handlers object, so follow that import.
 */
function methodsOf(file: string, src: string): string[] {
  const has = (code: string, m: string) => new RegExp(`^\\s+${m}\\s*:`, 'm').test(code)
  const inline = METHODS.filter((m) => has(src, m))
  if (inline.length > 0) return [...inline]
  const ref = src.match(/handlers:\s*(\w+)\s*[,}]/)?.[1]
  const from =
    ref && src.match(new RegExp(`import\\s*{[^}]*\\b${ref}\\b[^}]*}\\s*from\\s*'(\\.[^']+)'`))
  if (!from) return []
  const target = join(dirname(file), `${from[1]}.ts`)
  return methodsOf(target, readFileSync(target, 'utf8'))
}

describe('OpenAPI coverage', () => {
  it('documents every route under routes/api/v1', async () => {
    const { generateOpenAPISpec } = await import('../openapi')
    await import('../schemas')
    const spec = generateOpenAPISpec() as { paths?: Record<string, Record<string, unknown>> }

    const documented = new Set<string>()
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const m of METHODS) if (item[m.toLowerCase()]) documented.add(`${m} ${path}`)
    }

    const routes = routeFiles(ROUTES_DIR).flatMap(routeOperations)
    expect(routes.length).toBeGreaterThan(100)

    const missing = routes.filter((op) => !documented.has(op)).sort()
    expect(missing, `Routes without a registerPath call:\n${missing.join('\n')}`).toEqual([])

    // The reverse: nothing documented that no route serves.
    const served = new Set(routes)
    const phantom = [...documented].filter((op) => !served.has(op)).sort()
    expect(phantom, `Documented operations with no route:\n${phantom.join('\n')}`).toEqual([])
  })
})
