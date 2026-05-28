import { useCallback, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  ChatBubbleLeftIcon,
  InformationCircleIcon,
  ShieldCheckIcon,
  UserIcon,
} from '@heroicons/react/24/solid'
import { Button } from '@/components/ui/button'
import { FormError } from '@/components/shared/form-error'
import { useUpdateBoardAccess } from '@/lib/client/mutations'
import { settingsQueries } from '@/lib/client/queries/settings'
import { cn } from '@/lib/shared/utils/cn'
import type { BoardId } from '@quackback/ids'
import {
  type BoardAccess,
  DEFAULT_BOARD_ACCESS,
  type ModerationRuleValue,
} from '@/lib/shared/db-types'

/**
 * Per-board moderation form (R4 design, standalone page).
 *
 * Three tri-state rules (`inherit | on | off`) for anonPosts, signedPosts,
 * and comments. Each row's "Inherit" sub-pill shows the workspace's
 * resolved default ("On" / "Off") so admins can tell what they'd fall back
 * to.
 *
 * This form owns its own dirty state and only mutates the `moderation`
 * slice — on save it preserves the rest of `board.access` verbatim so a
 * concurrent edit on the Access page is never zeroed out.
 */

// ─── Workspace moderation defaults ────────────────────────────────────

/** Mirrors the policy-side `RequireApproval` type. Kept private to this
 *  module so the UI doesn't drag the server policy import. */
type RequireApproval = 'none' | 'anonymous' | 'authenticated' | 'all'
type ModerationAxis = 'anonPosts' | 'signedPosts' | 'comments'

/**
 * UI mirror of `resolveModerationRule` from policy/posts.ts — same axis
 * mapping, restricted to the `'inherit'` case since the SegmentedTri's
 * sub-pill only ever needs to render the resolved workspace default.
 *
 * Keep this in sync with the policy helper: any change to the workspace
 * default → per-axis mapping has to land in both places.
 */
function resolveWorkspaceDefault(
  axis: ModerationAxis,
  workspaceApproval: RequireApproval | undefined
): 'on' | 'off' {
  const ws = workspaceApproval ?? 'none'
  if (axis === 'comments') return ws === 'all' ? 'on' : 'off'
  if (axis === 'anonPosts') return ws === 'all' || ws === 'anonymous' ? 'on' : 'off'
  // signedPosts
  return ws === 'all' || ws === 'authenticated' ? 'on' : 'off'
}

// ─── Rule config ──────────────────────────────────────────────────────

interface ModerationRuleMeta {
  id: ModerationAxis
  label: string
  sub: string
  icon: React.ComponentType<{ className?: string }>
}

const MOD_RULES: readonly ModerationRuleMeta[] = [
  {
    id: 'anonPosts',
    label: 'Require approval for anonymous posts',
    sub: 'Posts from visitors without an account wait for review before they appear.',
    icon: UserIcon,
  },
  {
    id: 'signedPosts',
    label: 'Require approval for signed-in posts',
    sub: 'Posts from signed-in portal users wait for review before they appear.',
    icon: UserIcon,
  },
  {
    id: 'comments',
    label: 'Require approval for new comments',
    sub: 'Comments wait for review before they appear under a post.',
    icon: ChatBubbleLeftIcon,
  },
] as const

// ─── Form shape ───────────────────────────────────────────────────────

interface Board {
  id: BoardId
  access: BoardAccess
}

interface BoardModerationFormProps {
  board: Board
}

type ModerationShape = BoardAccess['moderation']

export function BoardModerationForm({ board }: BoardModerationFormProps) {
  const mutation = useUpdateBoardAccess()

  // Non-suspense so the form keeps rendering when the portalConfig cache
  // is empty (e.g. in tests). The default falls back to "none" so the
  // inheritance pill stays conservative until we know better.
  const portalConfigQuery = useQuery({ ...settingsQueries.portalConfig(), retry: false })
  const workspaceApproval: RequireApproval =
    portalConfigQuery.data?.moderationDefault?.requireApproval ?? 'none'

  const defaults: ModerationShape = board.access?.moderation ?? DEFAULT_BOARD_ACCESS.moderation

  const form = useForm<ModerationShape>({
    defaultValues: defaults,
  })

  // Sync form state when the server-side board.access changes (e.g. after
  // a successful save invalidates the boards query). We key on a stable
  // serialisation of the moderation slice so the form only resets when
  // the server-side data actually changes, not on every parent rerender.
  const moderationKey = JSON.stringify(defaults)
  useEffect(() => {
    form.reset(defaults)
  }, [moderationKey, defaults, form])

  const values = form.watch()
  const dirty = form.formState.isDirty

  const handleChange = useCallback(
    (axis: ModerationAxis, value: ModerationRuleValue) => {
      form.setValue(axis, value, { shouldDirty: true })
    },
    [form]
  )

  const onSubmit = useCallback(
    (next: ModerationShape) => {
      // Only touch the moderation slice — preserve the rest of access so a
      // concurrent edit on the Access page isn't zeroed out.
      mutation.mutate({
        boardId: board.id,
        access: { ...board.access, moderation: next },
      })
    },
    [board.id, board.access, mutation]
  )

  const handleDiscard = useCallback(() => {
    form.reset(defaults)
  }, [defaults, form])

  const anyOverridden = MOD_RULES.some((r) => values[r.id] !== 'inherit')

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pb-24">
      {mutation.isError && <FormError message={mutation.error?.message ?? 'An error occurred'} />}

      {/* Inheritance banner */}
      <div className="flex items-center gap-2.5 rounded-lg border bg-muted/30 px-3 py-2.5">
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
          <ShieldCheckIcon className="h-2.5 w-2.5" />
        </span>
        <div className="flex-1 text-xs text-foreground/90">
          {anyOverridden ? (
            <>
              This board <span className="font-medium text-primary">overrides</span> some workspace
              defaults.
            </>
          ) : (
            <>Inheriting all workspace defaults.</>
          )}
        </div>
        <Link
          to="/admin/settings/moderation"
          className="text-[11.5px] text-primary hover:underline whitespace-nowrap"
        >
          Workspace moderation →
        </Link>
      </div>

      {/* Rules */}
      <div className="flex flex-col">
        {MOD_RULES.map((r, idx) => (
          <ModerationRuleRow
            key={r.id}
            rule={r}
            value={values[r.id]}
            workspaceDefault={resolveWorkspaceDefault(r.id, workspaceApproval)}
            onChange={(v) => handleChange(r.id, v)}
            isLast={idx === MOD_RULES.length - 1}
          />
        ))}
      </div>

      <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <InformationCircleIcon className="h-3 w-3" />
        Held posts and comments appear in the <span className="text-foreground">review queue</span>.
      </p>

      <SaveDock dirty={dirty} saving={mutation.isPending} onDiscard={handleDiscard} />
    </form>
  )
}

// ─── Rule row + tri-state segmented control ──────────────────────────

interface ModerationRuleRowProps {
  rule: ModerationRuleMeta
  value: ModerationRuleValue
  workspaceDefault: 'on' | 'off'
  onChange: (value: ModerationRuleValue) => void
  isLast: boolean
}

function ModerationRuleRow({
  rule,
  value,
  workspaceDefault,
  onChange,
  isLast,
}: ModerationRuleRowProps) {
  const overridden = value !== 'inherit'
  return (
    <div className={cn('flex items-center gap-3.5 py-3.5', !isLast && 'border-b border-border')}>
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
        <rule.icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{rule.label}</span>
          {overridden && (
            <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-primary">
              Override
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{rule.sub}</div>
      </div>
      <SegmentedTri
        value={value}
        onChange={onChange}
        workspaceDefault={workspaceDefault}
        ruleLabel={rule.label}
      />
    </div>
  )
}

interface SegmentedTriProps {
  value: ModerationRuleValue
  onChange: (value: ModerationRuleValue) => void
  workspaceDefault: 'on' | 'off'
  ruleLabel: string
}

function SegmentedTri({ value, onChange, workspaceDefault, ruleLabel }: SegmentedTriProps) {
  const opts: ReadonlyArray<{
    id: ModerationRuleValue
    label: string
    sub: string | null
  }> = [
    { id: 'inherit', label: 'Inherit', sub: workspaceDefault === 'on' ? 'On' : 'Off' },
    { id: 'on', label: 'On', sub: null },
    { id: 'off', label: 'Off', sub: null },
  ]
  return (
    <div
      role="radiogroup"
      aria-label={ruleLabel}
      className="inline-flex shrink-0 rounded-md border bg-muted/30 p-0.5"
    >
      {opts.map((o) => {
        const on = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`${ruleLabel}: ${o.label}`}
            onClick={() => onChange(o.id)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors',
              on
                ? 'border border-primary/40 bg-primary/10 font-medium text-foreground'
                : 'border border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {o.label}
            {o.sub && (
              <span
                className={cn(
                  'rounded px-1 py-px text-[10px]',
                  on ? 'bg-muted text-muted-foreground' : 'text-muted-foreground/70'
                )}
              >
                {o.sub}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ─── Sticky save dock ────────────────────────────────────────────────

interface SaveDockProps {
  dirty: boolean
  saving: boolean
  onDiscard: () => void
}

function SaveDock({ dirty, saving, onDiscard }: SaveDockProps) {
  return (
    <div
      role="region"
      aria-label="Save changes"
      data-dirty={dirty || undefined}
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 border-t bg-background/85 backdrop-blur-sm transition-transform duration-200',
        dirty ? 'translate-y-0' : 'pointer-events-none translate-y-full'
      )}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3 sm:pl-72">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className="inline-block h-2 w-2 rounded-full bg-primary"
            style={{ boxShadow: '0 0 8px rgba(250, 204, 21, 0.6)' }}
          />
          You have unsaved changes.
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onDiscard} disabled={saving}>
            Discard
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  )
}
