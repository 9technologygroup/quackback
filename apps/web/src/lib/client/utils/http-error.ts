/**
 * Shared HTTP-error text extraction for the assistant's client surfaces (the
 * Copilot panel's SSE turns and the suggested-reply store). Pulls the
 * server's `{error:{message}}` body off a failed response, falling back to
 * one generic message so the fallback copy can never drift between surfaces.
 */

export const GENERIC_ERROR = 'Something went wrong. Try again.'

/** Pull the server's `{error:{message}}` body off a failed request, falling
 *  back to GENERIC_ERROR for a non-JSON (or empty) body. */
export async function extractHttpErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (body?.error?.message) return body.error.message as string
  } catch {
    // Non-JSON error body: keep the generic message.
  }
  return GENERIC_ERROR
}
