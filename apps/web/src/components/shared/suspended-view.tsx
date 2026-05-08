import { FriendlyShell } from './error-page'

export type WorkspaceState = 'active' | 'suspended' | 'deleting'

interface SuspendedViewProps {
  state: WorkspaceState
}

/**
 * Inline view rendered by __root.tsx when the workspace state is
 * suspended or deleting. The URL stays unchanged so when the state
 * flips back to active the next render shows the actual workspace.
 *
 * Same component is rendered by the /suspended route for direct hits.
 */
export function SuspendedView({ state }: SuspendedViewProps) {
  const isDeleting = state === 'deleting'
  const title = isDeleting
    ? 'This workspace is being archived.'
    : 'This workspace is currently unavailable.'
  const body = isDeleting
    ? 'Your data is being safely archived. If this was unexpected, get in touch with the workspace admin.'
    : 'Reach out to the workspace admin to restore access.'

  return (
    <FriendlyShell>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
    </FriendlyShell>
  )
}
