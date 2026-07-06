/**
 * The fullscreen builder's canvas (support platform §4.6): the same
 * auto-layout tree as the old dialog editor — trigger at top, steps run
 * top-to-bottom, a branch step fans out into labeled path columns — but
 * clicking a card selects it (the inspector panel on the right shows its
 * editor) instead of opening a popover, and a "+" connector opens the step
 * palette in that same panel instead of a dropdown. Invalid steps (e.g. an
 * "Assign to team" with no team chosen) get an amber border + warning badge,
 * sourced from the issues map the builder computes over the graph.
 */
import { Fragment, useEffect, useState } from 'react'
import {
  AdjustmentsHorizontalIcon,
  BoltIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  FlagIcon,
  FunnelIcon,
  MinusIcon,
  MoonIcon,
  PlusIcon,
  ShareIcon,
  ShieldCheckIcon,
  TagIcon,
  UserGroupIcon,
  UserPlusIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { cn } from '@/lib/shared/utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useWorkflowEntities } from './entities'
import type { BuilderSelection } from './types'
import {
  ROOT_LOCATION,
  PATH_LETTERS,
  actionSummary,
  conditionSummary,
  countSteps,
  waitSummary,
  type ActionType,
  type StepLocation,
  type TreeStep,
  type WorkflowTree,
} from '../workflow-graph'

export const ACTION_ICONS: Record<ActionType, typeof BoltIcon> = {
  assign_agent: UserPlusIcon,
  assign_team: UserGroupIcon,
  add_tag: TagIcon,
  remove_tag: TagIcon,
  set_priority: FlagIcon,
  snooze: MoonIcon,
  close: CheckCircleIcon,
  apply_sla: ShieldCheckIcon,
  set_attribute: AdjustmentsHorizontalIcon,
}

export const GATE_TINT = 'bg-amber-500/10 text-amber-600 dark:text-amber-500'
export const STEP_TINT = 'bg-muted text-muted-foreground'
const CARD_CLASS =
  'w-64 rounded-lg border bg-background p-2.5 text-left shadow-xs transition-colors'

function locationsEqual(a: StepLocation, b: StepLocation): boolean {
  if (a.path.length !== b.path.length) return false
  return a.path.every(
    (hop, i) => hop.branchId === b.path[i]?.branchId && hop.pathKey === b.path[i]?.pathKey
  )
}

function isActiveInsertion(
  selection: BuilderSelection,
  location: StepLocation,
  index: number
): boolean {
  return (
    selection?.kind === 'insert' &&
    selection.index === index &&
    locationsEqual(selection.location, location)
  )
}

interface CanvasHandlers {
  selection: BuilderSelection
  stepIssues: ReadonlyMap<string, string>
  onSelectNode: (id: string) => void
  onSelectInsertion: (location: StepLocation, index: number) => void
  onRemoveStep: (id: string) => void
}

export function WorkflowBuilderCanvas({
  tree,
  triggerLabel,
  selection,
  stepIssues,
  onSelectNode,
  onSelectInsertion,
  onRemoveStep,
}: { tree: WorkflowTree; triggerLabel: string } & CanvasHandlers) {
  const [zoom, setZoom] = useState(1)

  // Scroll the selected node into view — used by the outline rail, the
  // issues chip, and freshly inserted steps, all of which just select an id.
  useEffect(() => {
    if (selection?.kind !== 'node') return
    const el = document.querySelector(`[data-step-id="${CSS.escape(selection.id)}"]`)
    el?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
  }, [selection])

  return (
    <div className="relative flex-1 overflow-auto bg-muted/20 [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:18px_18px]">
      <div
        className="mx-auto w-max min-w-full px-16 py-14"
        style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
      >
        <div className="flex flex-col items-center">
          <TriggerCard
            id={tree.triggerId}
            label={triggerLabel}
            selected={selection?.kind === 'node' && selection.id === tree.triggerId}
            onSelect={() => onSelectNode(tree.triggerId)}
          />
          <StepList
            steps={tree.steps}
            location={ROOT_LOCATION}
            selection={selection}
            stepIssues={stepIssues}
            onSelectNode={onSelectNode}
            onSelectInsertion={onSelectInsertion}
            onRemoveStep={onRemoveStep}
            root
          />
        </div>
      </div>

      <ZoomControls zoom={zoom} onZoom={setZoom} />
    </div>
  )
}

function ZoomControls({ zoom, onZoom }: { zoom: number; onZoom: (z: number) => void }) {
  const nudge = (delta: number) =>
    onZoom(Math.min(1.5, Math.max(0.5, Math.round((zoom + delta) * 10) / 10)))
  return (
    <div className="absolute bottom-4 left-4 flex items-center overflow-hidden rounded-lg border bg-background shadow-xs">
      <button
        type="button"
        aria-label="Zoom out"
        onClick={() => nudge(-0.1)}
        className="flex size-8 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <MinusIcon className="size-3.5" />
      </button>
      <span className="w-12 text-center text-xs font-medium tabular-nums">
        {Math.round(zoom * 100)}%
      </span>
      <button
        type="button"
        aria-label="Zoom in"
        onClick={() => nudge(0.1)}
        className="flex size-8 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <PlusIcon className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => onZoom(1)}
        className="h-8 border-l px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        Fit
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Layout: one path column, connectors, the "+" insertion affordance
// ---------------------------------------------------------------------------

function StepList({
  steps,
  location,
  selection,
  stepIssues,
  onSelectNode,
  onSelectInsertion,
  onRemoveStep,
  root = false,
}: { steps: TreeStep[]; location: StepLocation; root?: boolean } & CanvasHandlers) {
  const endsInBranch = steps[steps.length - 1]?.kind === 'branch'

  return (
    <>
      {steps.map((step, i) => (
        <Fragment key={step.id}>
          <Connector
            onInsert={() => onSelectInsertion(location, i)}
            active={isActiveInsertion(selection, location, i)}
          />
          <StepCard
            step={step}
            location={location}
            selection={selection}
            stepIssues={stepIssues}
            onSelectNode={onSelectNode}
            onSelectInsertion={onSelectInsertion}
            onRemoveStep={onRemoveStep}
          />
        </Fragment>
      ))}
      {!endsInBranch && (
        <>
          <Connector
            end
            onInsert={() => onSelectInsertion(location, steps.length)}
            active={isActiveInsertion(selection, location, steps.length)}
          />
          {root && steps.length === 0 && (
            <p className="mt-1.5 text-xs text-muted-foreground">Add the first step</p>
          )}
        </>
      )}
    </>
  )
}

function Connector({
  onInsert,
  active,
  end = false,
}: {
  onInsert: () => void
  active: boolean
  end?: boolean
}) {
  return (
    <div className="flex flex-col items-center">
      <div className="h-2.5 w-px bg-border" />
      <button
        type="button"
        aria-label="Add step"
        onClick={onInsert}
        className={cn(
          'flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-xs transition-colors hover:border-primary/50 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          active && 'border-primary text-primary ring-2 ring-primary/30'
        )}
      >
        <PlusIcon className="size-3" />
      </button>
      {!end && <div className="h-2.5 w-px bg-border" />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function CardBody({
  icon: Icon,
  tint,
  eyebrow,
  title,
}: {
  icon: typeof BoltIcon
  tint: string
  eyebrow: string
  title: string
}) {
  return (
    <span className="flex items-start gap-2.5">
      <span
        className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md', tint)}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0">
        <span className="block text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {eyebrow}
        </span>
        <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug font-medium">
          {title}
        </span>
      </span>
    </span>
  )
}

function TriggerCard({
  id,
  label,
  selected,
  onSelect,
}: {
  id: string
  label: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      data-step-id={id}
      onClick={onSelect}
      className={cn(
        CARD_CLASS,
        'w-72 cursor-pointer border-primary/25 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        selected && 'border-primary shadow-md ring-2 ring-primary/20'
      )}
    >
      <CardBody icon={BoltIcon} tint="bg-primary/10 text-primary" eyebrow="Trigger" title={label} />
    </button>
  )
}

function DeleteStepButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="pointer-events-none absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-xs transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:text-destructive focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <XMarkIcon className="size-3" />
    </button>
  )
}

function StepCard({
  step,
  location,
  selection,
  stepIssues,
  onSelectNode,
  onSelectInsertion,
  onRemoveStep,
}: { step: TreeStep; location: StepLocation } & CanvasHandlers) {
  const { labels } = useWorkflowEntities()

  if (step.kind === 'branch') {
    return (
      <BranchCard
        step={step}
        location={location}
        selection={selection}
        stepIssues={stepIssues}
        onSelectNode={onSelectNode}
        onSelectInsertion={onSelectInsertion}
        onRemoveStep={onRemoveStep}
      />
    )
  }

  const selected = selection?.kind === 'node' && selection.id === step.id
  const issue = stepIssues.get(step.id)
  const card =
    step.kind === 'action'
      ? {
          icon: ACTION_ICONS[step.action.type],
          tint: STEP_TINT,
          eyebrow: 'Action',
          title: actionSummary(step.action, labels),
          deleteLabel: 'Delete action step',
        }
      : step.kind === 'condition'
        ? {
            icon: FunnelIcon,
            tint: GATE_TINT,
            eyebrow: 'Condition',
            title: conditionSummary(step.condition),
            deleteLabel: 'Delete condition step',
          }
        : {
            icon: ClockIcon,
            tint: STEP_TINT,
            eyebrow: 'Wait',
            title: waitSummary(step.seconds),
            deleteLabel: 'Delete wait step',
          }

  return (
    <div className="group relative">
      <button
        type="button"
        data-step-id={step.id}
        onClick={() => onSelectNode(step.id)}
        className={cn(
          CARD_CLASS,
          'relative cursor-pointer hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          selected && 'border-primary shadow-md ring-2 ring-primary/20',
          issue && 'border-amber-500/60',
          issue && selected && 'ring-2 ring-amber-500/30'
        )}
      >
        <CardBody icon={card.icon} tint={card.tint} eyebrow={card.eyebrow} title={card.title} />
        {issue && (
          <span className="absolute top-2 right-2 text-amber-600 dark:text-amber-500" title={issue}>
            <ExclamationTriangleIcon className="size-3.5" />
          </span>
        )}
      </button>
      <DeleteStepButton label={card.deleteLabel} onClick={() => onRemoveStep(step.id)} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Branch: the card, the labeled path columns
// ---------------------------------------------------------------------------

function BranchCard({
  step,
  location,
  selection,
  stepIssues,
  onSelectNode,
  onSelectInsertion,
  onRemoveStep,
}: { step: Extract<TreeStep, { kind: 'branch' }>; location: StepLocation } & CanvasHandlers) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const nested = step.paths.reduce((n, p) => n + countSteps(p.steps), 0)
  const selected = selection?.kind === 'node' && selection.id === step.id
  const issue = stepIssues.get(step.id)

  return (
    <div className="flex flex-col items-center">
      <div className="group relative">
        <button
          type="button"
          data-step-id={step.id}
          onClick={() => onSelectNode(step.id)}
          className={cn(
            CARD_CLASS,
            'relative cursor-pointer hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            selected && 'border-primary shadow-md ring-2 ring-primary/20',
            issue && 'border-amber-500/60'
          )}
        >
          <CardBody
            icon={ShareIcon}
            tint={GATE_TINT}
            eyebrow="Branch · first match"
            title={`${step.paths.length} path${step.paths.length === 1 ? '' : 's'}`}
          />
        </button>
        <DeleteStepButton
          label="Delete branch step"
          onClick={() => (nested > 0 ? setConfirmOpen(true) : onRemoveStep(step.id))}
        />
      </div>

      <div className="h-2.5 w-px bg-border" />
      <div className="flex items-start">
        {step.paths.map((path, i) => {
          const pathLocation: StepLocation = {
            path: [...location.path, { branchId: step.id, pathKey: path.key }],
          }
          const letter = PATH_LETTERS[i] ?? String(i + 1)
          return (
            <div key={path.key} className="relative flex flex-col items-center px-3 pt-2.5">
              <div
                className={cn(
                  'absolute top-0 h-px bg-border',
                  i === 0 ? 'right-0 left-1/2' : 'inset-x-0'
                )}
              />
              <div className="absolute top-0 left-1/2 h-2.5 w-px -translate-x-1/2 bg-border" />
              <span className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                <span className="flex size-4 items-center justify-center rounded bg-muted text-[10px] font-bold text-foreground">
                  {letter}
                </span>
                {path.key}
              </span>
              <div className="w-56 rounded-lg border border-dashed border-border bg-muted/20 px-3 py-2 text-center text-xs text-muted-foreground">
                {conditionSummary(path.condition)}
              </div>
              <div className="h-2.5 w-px bg-border" />
              <StepList
                steps={path.steps}
                location={pathLocation}
                selection={selection}
                stepIssues={stepIssues}
                onSelectNode={onSelectNode}
                onSelectInsertion={onSelectInsertion}
                onRemoveStep={onRemoveStep}
              />
            </div>
          )
        })}
      </div>

      <ConfirmDeleteDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete this branch?"
        description={`Its paths and their ${nested} step${nested === 1 ? '' : 's'} will be removed.`}
        onConfirm={() => onRemoveStep(step.id)}
      />
    </div>
  )
}

export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
