import { createFileRoute, Link } from '@tanstack/react-router'
import { FormattedMessage } from 'react-intl'
import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { HelpCenterHeroSearch } from '@/components/help-center/help-center-search'
import { HelpCenterCategoryGrid } from '@/components/help-center/help-center-category-grid'
import {
  listPublicCategoriesFn,
  listPublicCategoryEditorsFn,
} from '@/lib/server/functions/help-center'
import type { HelpCenterConfig } from '@/lib/shared/types/settings'

export const Route = createFileRoute('/_portal/hc/')({
  loader: async ({ context }) => {
    const { settings } = context
    const helpCenterConfig = settings?.helpCenterConfig as HelpCenterConfig | undefined
    const [categories, editors] = await Promise.all([
      listPublicCategoriesFn({ data: {} }),
      listPublicCategoryEditorsFn({ data: {} }),
    ])

    return {
      categories,
      editors,
      helpCenterConfig: helpCenterConfig ?? null,
      workspaceName: settings?.name ?? 'Help Center',
      logoUrl: settings?.brandingData?.logoUrl || '/logo.png',
    }
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {}

    const { helpCenterConfig, workspaceName, logoUrl } = loaderData
    const title = helpCenterConfig?.homepageTitle ?? 'How can we help?'
    const description =
      helpCenterConfig?.homepageDescription ?? 'Search our knowledge base or browse by category'

    const pageTitle = `${title} - ${workspaceName}`

    return {
      meta: [
        { title: pageTitle },
        { name: 'description', content: description },
        { property: 'og:title', content: pageTitle },
        { property: 'og:description', content: description },
        { property: 'og:image', content: logoUrl },
        { name: 'twitter:title', content: pageTitle },
        { name: 'twitter:description', content: description },
      ],
    }
  },
  component: HelpCenterLandingPage,
})

function HelpCenterLandingPage() {
  const { categories, editors, helpCenterConfig } = Route.useLoaderData()
  const { settings } = Route.useRouteContext()
  const supportEnabled =
    !!settings?.featureFlags?.supportInbox && !!settings?.portalConfig?.support?.enabled
  const askAiEnabled = !!settings?.featureFlags?.helpCenterAiAnswers

  const title = helpCenterConfig?.homepageTitle ?? 'How can we help?'
  const description =
    helpCenterConfig?.homepageDescription ?? 'Search our knowledge base or browse by category'

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10">
      <div className="text-center mb-10 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <h1 className="text-3xl sm:text-4xl font-bold text-foreground mb-3">{title}</h1>
        <p className="text-muted-foreground text-base mb-8">{description}</p>
        <HelpCenterHeroSearch askAiEnabled={askAiEnabled} />
      </div>

      <div
        className="animate-in fade-in duration-300 fill-mode-backwards"
        style={{ animationDelay: '100ms' }}
      >
        <HelpCenterCategoryGrid categories={categories} editors={editors} />
      </div>

      {supportEnabled && (
        <div
          className="mx-auto mt-12 flex max-w-2xl flex-wrap items-center justify-between gap-4 rounded-xl border border-border/60 bg-card px-6 py-5 animate-in fade-in duration-300 fill-mode-backwards"
          style={{ animationDelay: '150ms' }}
        >
          <div className="flex items-center gap-3">
            <ChatBubbleLeftRightIcon className="size-8 shrink-0 text-primary" />
            <div>
              <p className="text-sm font-semibold text-foreground">
                <FormattedMessage
                  id="portal.hc.contactSupport.title"
                  defaultMessage="Still need help?"
                />
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                <FormattedMessage
                  id="portal.hc.contactSupport.body"
                  defaultMessage="Start a conversation with our team and we'll get back to you."
                />
              </p>
            </div>
          </div>
          <Button asChild size="sm">
            <Link to="/support/$conversationId" params={{ conversationId: 'new' }}>
              <FormattedMessage
                id="portal.hc.contactSupport.cta"
                defaultMessage="Contact support"
              />
            </Link>
          </Button>
        </div>
      )}
    </div>
  )
}
