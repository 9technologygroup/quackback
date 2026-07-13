import { createFileRoute } from '@tanstack/react-router'
import { useIntl } from 'react-intl'
import { BeakerIcon } from '@heroicons/react/24/solid'
import { TestAgentCard } from '@/components/admin/automation/test-agent-card'
import { DefaultErrorPage } from '@/components/shared/error-page'
import { PageHeader } from '@/components/shared/page-header'
import { BackLink } from '@/components/ui/back-link'
import { assistantQueries } from '@/lib/client/queries/assistant'
import { PERMISSIONS, type PermissionKey } from '@/lib/shared/permissions'

export const Route = createFileRoute('/admin/automation/test')({
  beforeLoad: ({ context }) => {
    const permissions = (context as { permissions?: PermissionKey[] }).permissions ?? []
    if (!permissions.includes(PERMISSIONS.ASSISTANT_MANAGE)) {
      throw new Error('Access denied: requires assistant.manage')
    }
  },
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(assistantQueries.settings())
  },
  errorComponent: ({ error, reset }) => (
    <DefaultErrorPage error={error} reset={reset} fullPage={false} />
  ),
  component: AutomationTestPage,
})

function AutomationTestPage() {
  const intl = useIntl()
  return (
    <div className="max-w-3xl space-y-6">
      <div className="lg:hidden">
        <BackLink to="/admin/automation">
          {intl.formatMessage({ id: 'automation.nav.label', defaultMessage: 'AI & Automation' })}
        </BackLink>
      </div>
      <PageHeader
        icon={BeakerIcon}
        title={intl.formatMessage({ id: 'automation.test.title', defaultMessage: 'Test agent' })}
        description={intl.formatMessage({
          id: 'automation.test.description',
          defaultMessage:
            'Try realistic customer questions using your saved settings. Nothing here is added to your inbox or sent to customers.',
        })}
      />
      <TestAgentCard liveChannels={['widget']} />
    </div>
  )
}
