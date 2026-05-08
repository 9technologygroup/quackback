import { createFileRoute } from '@tanstack/react-router'
import { Route as RootRoute } from './__root'

export const Route = createFileRoute('/suspended')({ component: SuspendedPage })

function SuspendedPage() {
  const ctx = RootRoute.useRouteContext()
  const reason =
    ctx.state === 'deleting'
      ? 'This workspace is being deleted.'
      : 'This workspace is suspended for non-payment. Contact your administrator to reactivate.'
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8">
      <h1 className="text-2xl font-semibold mb-4">Workspace unavailable</h1>
      <p className="text-zinc-600">{reason}</p>
    </div>
  )
}
