/**
 * The right inspector panel: dispatches on the current selection to the
 * trigger editor, a step editor (condition/branch/wait/action), the step
 * palette (an active "+" insertion point), or an empty state. Replaces every
 * Popover the dialog-based editor used to open — this is the one place all
 * step configuration lives now.
 */
import type { ComponentType } from 'react'
import { BoltIcon, ClockIcon, FunnelIcon, PlusIcon, ShareIcon } from '@heroicons/react/24/outline'
import { ACTION_ICONS, GATE_TINT, STEP_TINT } from '../canvas'
import type { BuilderSelection } from '../types'
import type { TriggerSettingsDraft } from '../use-workflow-builder'
import { ActionEditor } from './action-editor'
import { BranchEditor } from './branch-editor'
import { ConditionEditor } from './condition-editor'
import { StepPalette } from './palette'
import { TriggerEditor } from './trigger-editor'
import { WaitEditor } from './wait-editor'
import {
  ACTION_LABELS,
  findStepById,
  type ActionType,
  type TreeStep,
  type WorkflowClassValue,
  type WorkflowTree,
} from '../../workflow-graph'

export function InspectorPanel({
  mode,
  tree,
  selection,
  stepIssues,
  triggerType,
  onChangeTriggerType,
  triggerSettings,
  onChangeTriggerSettings,
  workflowClass,
  onChangeClass,
  onInsert,
  onUpdateStep,
}: {
  mode: 'visual' | 'json'
  tree: WorkflowTree | null
  selection: BuilderSelection
  stepIssues: ReadonlyMap<string, string>
  triggerType: string
  onChangeTriggerType: (v: string) => void
  triggerSettings: TriggerSettingsDraft
  onChangeTriggerSettings: (v: TriggerSettingsDraft) => void
  workflowClass: WorkflowClassValue
  onChangeClass: (v: WorkflowClassValue) => void
  onInsert: (kind: TreeStep['kind'], actionType?: ActionType) => void
  onUpdateStep: (updater: (step: TreeStep) => TreeStep) => void
}) {
  if (mode === 'json') {
    return (
      <InspectorEmpty message="Editing as JSON. Switch to Visual to use the inspector panel." />
    )
  }
  if (!selection) {
    return <InspectorEmpty message='Select a step to edit it, or click a "+" to add one.' />
  }
  if (selection.kind === 'insert') {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto">
        <InspectorHeader
          icon={PlusIcon}
          tint={STEP_TINT}
          title="Add a step"
          subtitle="Choose what runs next"
        />
        <StepPalette onInsert={onInsert} />
      </div>
    )
  }
  if (!tree) return <InspectorEmpty message="Nothing to edit." />

  if (selection.id === tree.triggerId) {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto">
        <InspectorHeader
          icon={BoltIcon}
          tint="bg-primary/10 text-primary"
          title="Trigger"
          subtitle="Starts the workflow"
        />
        <div className="p-3">
          <TriggerEditor
            triggerType={triggerType}
            onChangeTriggerType={onChangeTriggerType}
            triggerSettings={triggerSettings}
            onChangeTriggerSettings={onChangeTriggerSettings}
            workflowClass={workflowClass}
            onChangeClass={onChangeClass}
          />
        </div>
      </div>
    )
  }

  const found = findStepById(tree, selection.id)
  if (!found) return <InspectorEmpty message="This step no longer exists." />
  const { step } = found
  const issue = stepIssues.get(step.id)

  if (step.kind === 'condition') {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto">
        <InspectorHeader
          icon={FunnelIcon}
          tint={GATE_TINT}
          title="Condition"
          subtitle="Continue only if this matches"
        />
        <div className="p-3">
          <ConditionEditor
            subject="Continue when"
            condition={step.condition}
            onChange={(condition) =>
              onUpdateStep((s) => (s.kind === 'condition' ? { ...s, condition } : s))
            }
          />
        </div>
      </div>
    )
  }

  if (step.kind === 'branch') {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto">
        <InspectorHeader
          icon={ShareIcon}
          tint={GATE_TINT}
          title="Branch"
          subtitle="First matching path runs"
        />
        <div className="p-3">
          <BranchEditor step={step} onChange={(next) => onUpdateStep(() => next)} />
        </div>
      </div>
    )
  }

  if (step.kind === 'wait') {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto">
        <InspectorHeader icon={ClockIcon} tint={STEP_TINT} title="Wait" subtitle="Action" />
        <div className="p-3">
          <WaitEditor
            seconds={step.seconds}
            onChange={(seconds) => onUpdateStep((s) => (s.kind === 'wait' ? { ...s, seconds } : s))}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <InspectorHeader
        icon={ACTION_ICONS[step.action.type]}
        tint={STEP_TINT}
        title={ACTION_LABELS[step.action.type]}
        subtitle="Action"
      />
      <div className="space-y-2.5 p-3">
        {issue && (
          <p className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-500">
            {issue}
          </p>
        )}
        <ActionEditor
          action={step.action}
          onChange={(action) => onUpdateStep((s) => (s.kind === 'action' ? { ...s, action } : s))}
        />
      </div>
    </div>
  )
}

function InspectorHeader({
  icon: Icon,
  tint,
  title,
  subtitle,
}: {
  icon: ComponentType<{ className?: string }>
  tint: string
  title: string
  subtitle: string
}) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-border/50 bg-background px-3 py-3">
      <span className={`flex size-8 shrink-0 items-center justify-center rounded-md ${tint}`}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
      </div>
    </div>
  )
}

function InspectorEmpty({ message }: { message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
      {message}
    </div>
  )
}
