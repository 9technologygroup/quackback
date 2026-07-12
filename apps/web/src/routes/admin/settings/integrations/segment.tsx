import { createFileRoute } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { adminQueries } from '@/lib/client/queries/admin'
import { IntegrationHeader } from '@/components/admin/settings/integrations/integration-header'
import { IntegrationSetupCard } from '@/components/admin/settings/integrations/integration-setup-card'
import { SegmentConnectionActions } from '@/components/admin/settings/integrations/segment/segment-connection-actions'
import { segmentCatalog } from '@/lib/shared/integration-catalog'

export const Route = createFileRoute('/admin/settings/integrations/segment')({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(adminQueries.integrationByType('segment'))
    return {}
  },
  component: SegmentIntegrationPage,
})

function SegmentIntegrationPage() {
  const { integration } = useSuspenseQuery(adminQueries.integrationByType('segment')).data
  const connected = integration?.status === 'active' || integration?.status === 'paused'
  const icon = (
    <span className="flex size-6 items-center justify-center font-semibold" aria-hidden="true">
      S
    </span>
  )
  return (
    <div className="space-y-6">
      <IntegrationHeader
        catalog={segmentCatalog}
        status={integration?.status as 'active' | 'paused' | 'pending' | null}
        workspaceName={integration?.workspaceName}
        icon={icon}
        actions={
          connected ? (
            <SegmentConnectionActions integrationId={integration?.id} isConnected />
          ) : undefined
        }
      />
      {!connected && (
        <IntegrationSetupCard
          icon={icon}
          title="Connect Segment"
          description="Verify signed identify events and optionally publish segment membership changes."
          steps={[
            <p key="secret">Copy the signing secret from your Segment source or destination.</p>,
            <p key="endpoint">
              Send identify events to <code>/api/integrations/segment/identify</code>.
            </p>,
            <p key="rotate">Reconnect here whenever you rotate either secret.</p>,
          ]}
          connectionForm={<SegmentConnectionActions isConnected={false} />}
        />
      )}
    </div>
  )
}
