/**
 * Shapes a device authorization request (`POST /device/code`) before Better
 * Auth sees it.
 *
 * - `resource` defaults to the MCP endpoint, as the token exchange does. Without
 *   it Better Auth issues opaque tokens instead of audience-bound JWTs, which
 *   the MCP handler cannot verify.
 * - `user_id` is dropped. The library accepts it to pre-bind a code to a
 *   person, which would let any caller of this unauthenticated endpoint choose
 *   who a code belongs to. Codes bind to whoever opens them.
 *
 * Any other request is returned untouched. Reading a body consumes it, so a
 * changed request is rebuilt rather than passed on spent.
 */

export function isDeviceCodeRequest(request: Request): boolean {
  return request.method === 'POST' && new URL(request.url).pathname.endsWith('/device/code')
}

export async function prepareDeviceCodeRequest(
  request: Request,
  mcpResource: string
): Promise<Request> {
  if (!isDeviceCodeRequest(request)) return request
  const contentType = request.headers.get('content-type') ?? ''

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(await request.text())
    params.delete('user_id')
    if (!params.get('resource')) params.set('resource', mcpResource)
    return new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: params.toString(),
    })
  }

  if (contentType.includes('application/json')) {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      body = null
    }
    const fields: Record<string, unknown> =
      body && typeof body === 'object' && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>) }
        : {}
    delete fields.user_id
    if (!fields.resource) fields.resource = mcpResource
    return new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(fields),
    })
  }

  return request
}
