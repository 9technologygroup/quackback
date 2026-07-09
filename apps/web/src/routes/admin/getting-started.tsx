import { createFileRoute, Link, useRouteContext } from '@tanstack/react-router'
import { useState } from 'react'
import { useSuspenseQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { adminQueries } from '@/lib/client/queries/admin'
import { toggleLaunchTaskSkipFn } from '@/lib/server/functions/admin'
import {
  ChatBubbleLeftIcon,
  UsersIcon,
  SwatchIcon,
  CodeBracketIcon,
  ChatBubbleLeftRightIcon,
  BookOpenIcon,
  SignalIcon,
  PuzzlePieceIcon,
  CheckIcon,
  ArrowRightIcon,
  ArrowUturnLeftIcon,
  RocketLaunchIcon,
} from '@heroicons/react/24/solid'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/shared/page-header'
import { cn } from '@/lib/shared/utils'
import {
  launchChecklistSummary,
  OUTCOME_TAB_LABEL,
  OUTCOME_HOME,
} from '@/lib/shared/launch-checklist'
import {
  ONBOARDING_OUTCOMES,
  normalizeOnboardingOutcome,
  type OnboardingOutcome,
} from '@/lib/shared/db-types'

const taskIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  'create-board': ChatBubbleLeftIcon,
  'invite-team': UsersIcon,
  'customize-branding': SwatchIcon,
  'add-to-site': CodeBracketIcon,
  messenger: ChatBubbleLeftRightIcon,
  'help-article': BookOpenIcon,
  'status-component': SignalIcon,
  'connect-integration': PuzzlePieceIcon,
}

export const Route = createFileRoute('/admin/getting-started')({
  loader: async ({ context }) => {
    const { settings, queryClient } = context
    await queryClient.ensureQueryData(adminQueries.onboardingStatus())
    return { settings }
  },
  component: GettingStartedPage,
})

function GettingStartedPage() {
  const { settings } = Route.useLoaderData()
  const statusQuery = useSuspenseQuery(adminQueries.onboardingStatus())
  const queryClient = useQueryClient()
  const { userRole } = useRouteContext({ from: '__root__' })
  // Skipping persists to workspace settings (SETTINGS_MANAGE); the page itself
  // is viewable by members, so hide the control rather than let it fail.
  const canSkip = userRole === 'admin'

  // The workspace's chosen goal drives the default tab; other tabs are just
  // previews of what that goal's checklist would look like — every tab reads
  // the same real completion state, only the task selection/order changes.
  const primaryOutcome = normalizeOnboardingOutcome(statusQuery.data.useCase) ?? 'product_feedback'
  const [activeOutcome, setActiveOutcome] = useState<OnboardingOutcome>(primaryOutcome)

  const skipMutation = useMutation({
    mutationFn: (vars: { taskId: string; skipped: boolean }) =>
      toggleLaunchTaskSkipFn({ data: vars }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'onboarding'] }),
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Couldn't update the checklist. Try again."
      )
    },
  })

  const summary = launchChecklistSummary(statusQuery.data, activeOutcome)
  const { tasks, doneCount, remaining, allComplete, headline, outcome } = summary
  const home = OUTCOME_HOME[outcome]

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <PageHeader
        icon={RocketLaunchIcon}
        title="Launch checklist"
        description={allComplete ? `${settings!.name} is ready for day-to-day work` : headline}
        animate
      />

      <Tabs
        value={activeOutcome}
        onValueChange={(v) => setActiveOutcome(v as OnboardingOutcome)}
        variant="line"
      >
        <TabsList>
          {ONBOARDING_OUTCOMES.map((o) => (
            <TabsTrigger key={o} value={o}>
              {OUTCOME_TAB_LABEL[o]}
              {o === primaryOutcome && (
                <Badge size="sm" shape="pill" variant="secondary">
                  Your goal
                </Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex items-center gap-3">
        <div className="flex flex-1 gap-1.5">
          {tasks.map((task) => (
            <div
              key={task.id}
              className={cn(
                'h-1.5 flex-1 rounded-full transition-all duration-500',
                task.isCompleted
                  ? 'bg-primary'
                  : task.isSkipped
                    ? 'bg-muted-foreground/30'
                    : 'bg-border/60'
              )}
            />
          ))}
        </div>
        <span className="text-xs font-medium tabular-nums text-muted-foreground">
          {doneCount} of {tasks.length}
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-border/50 bg-card shadow-sm divide-y divide-border/50">
        {tasks.map((task, index) => {
          const Icon = taskIcons[task.id] ?? RocketLaunchIcon
          const isDone = task.isCompleted || task.isSkipped
          return (
            <div
              key={task.id}
              className={cn(
                'flex items-start gap-4 p-5 transition-colors animate-in fade-in fill-mode-backwards',
                !isDone && 'hover:bg-muted/30',
                isDone && 'bg-muted/20'
              )}
              style={{ animationDelay: `${index * 75}ms`, animationDuration: '300ms' }}
            >
              <div
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-all',
                  isDone ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
                )}
              >
                {task.isCompleted ? (
                  <CheckIcon className="h-4 w-4" />
                ) : task.isSkipped ? (
                  <span className="text-sm font-semibold">–</span>
                ) : (
                  <span className="text-sm font-semibold">{index + 1}</span>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3
                      className={cn(
                        'text-sm font-medium',
                        task.isCompleted
                          ? 'text-muted-foreground line-through decoration-muted-foreground/40'
                          : task.isSkipped
                            ? 'text-muted-foreground'
                            : 'text-foreground'
                      )}
                    >
                      {task.title}
                    </h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {task.isSkipped && !task.isCompleted ? 'Skipped' : task.description}
                    </p>
                  </div>
                  <Icon
                    className={cn(
                      'h-[18px] w-[18px] shrink-0 mt-0.5',
                      isDone ? 'text-primary/30' : 'text-muted-foreground/50'
                    )}
                  />
                </div>

                <div className="mt-3 flex items-center gap-2">
                  <Button
                    variant={task.isCompleted ? 'outline' : 'default'}
                    size="sm"
                    className="h-8"
                    asChild
                  >
                    <Link to={task.href}>
                      {task.isCompleted ? task.completedLabel : task.actionLabel}
                      <ArrowRightIcon className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                  {!task.isCompleted && canSkip && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 text-muted-foreground"
                      disabled={skipMutation.isPending}
                      onClick={() =>
                        skipMutation.mutate({ taskId: task.id, skipped: !task.isSkipped })
                      }
                    >
                      {task.isSkipped ? (
                        <>
                          <ArrowUturnLeftIcon className="h-3.5 w-3.5" />
                          Unskip
                        </>
                      ) : (
                        'Skip'
                      )}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {allComplete ? (
        <div className="flex items-center justify-center gap-2 py-2 animate-in fade-in duration-300">
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15">
            <CheckIcon className="h-3 w-3 text-primary" />
          </div>
          <p className="text-sm text-muted-foreground">
            You&apos;re ready:{' '}
            <Link to={home.href} className="text-primary hover:underline underline-offset-2">
              {home.label}
            </Link>
          </p>
        </div>
      ) : (
        <p className="text-center text-xs text-muted-foreground">
          {remaining} step{remaining === 1 ? '' : 's'} left · switch tabs above to preview a
          different goal
        </p>
      )}
    </div>
  )
}
