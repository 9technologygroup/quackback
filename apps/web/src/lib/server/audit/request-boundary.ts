/**
 * The request boundary for audit attribution; see middleware/audit-attribution.ts,
 * which loads this lazily so the start entry never pulls server modules into
 * the client build.
 */
import { runWithAuditAttribution, UI_ATTRIBUTION } from '@/lib/server/audit/attribution'
import { isApiWrite, recordApiWrite } from '@/lib/server/audit/api-write'

interface NextResult {
  response?: Response
}

/** Core handling, decoupled from the framework so it can be unit tested. */
export async function handleRequestWithAuditAttribution<T extends NextResult>({
  request,
  handlerType,
  next,
}: {
  request: Request
  handlerType: 'serverFn' | 'router'
  next: () => Promise<T>
}): Promise<T> {
  return runWithAuditAttribution(handlerType === 'serverFn' ? UI_ATTRIBUTION : null, async () => {
    if (handlerType === 'serverFn' || !isApiWrite(request)) return next()

    let result: T
    try {
      result = await next()
    } catch (error) {
      await recordApiWrite(request, null)
      throw error
    }
    // A route always answers with a response; without one there is no outcome
    // to record.
    if (result.response) await recordApiWrite(request, result.response)
    return result
  })
}
