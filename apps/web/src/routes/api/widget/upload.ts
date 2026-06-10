import { createFileRoute } from '@tanstack/react-router'
import { auth } from '@/lib/server/auth'
import { isS3Configured, uploadImageFromFormData } from '@/lib/server/storage/s3'
import { handleDomainError } from '@/lib/server/domains/api/responses'
import { DomainException } from '@/lib/shared/errors'

export async function handleWidgetUpload({ request }: { request: Request }): Promise<Response> {
  // Block writes from suspended/deleting workspaces. Read-only widget
  // routes (config, search, kb-search) stay open so end-users see a
  // working portal even while the workspace is past-due.
  try {
    const { ensureNotSuspended } = await import('@/lib/server/middleware/suspension-guard')
    await ensureNotSuspended()
  } catch (e) {
    if (e instanceof DomainException) return handleDomainError(e)
    throw e
  }
  // Any valid widget session may attach images — identified or anonymous. We
  // resolve the Bearer the same way server functions do: the better-auth bearer
  // plugin strips the token signature and looks up the session (a raw
  // `session.token` equality check fails because the bearer value is signed).
  const sessionData = await auth.api.getSession({ headers: request.headers })
  if (!sessionData?.user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isS3Configured()) {
    return Response.json({ error: 'Storage not configured' }, { status: 503 })
  }
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }
  return uploadImageFromFormData(formData, 'widget-images')
}

export const Route = createFileRoute('/api/widget/upload')({
  server: {
    handlers: {
      POST: handleWidgetUpload,
    },
  },
})
