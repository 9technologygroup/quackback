/**
 * The trigger step editor: which event starts the workflow, which channels
 * it fires for, and the workflow's class (customer-facing/exclusive vs.
 * background/parallel — support platform §4.6's dispatcher split).
 */
import { CheckIcon } from '@heroicons/react/24/outline'
import { cn } from '@/lib/shared/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { TriggerSettingsDraft } from '../use-workflow-builder'
import { Field } from './shared'
import {
  TRIGGER_CHANNELS,
  TRIGGER_LABELS,
  TRIGGER_TYPES,
  WORKFLOW_CLASSES,
  type WorkflowClassValue,
} from '../../workflow-graph'

export function TriggerEditor({
  triggerType,
  onChangeTriggerType,
  triggerSettings,
  onChangeTriggerSettings,
  workflowClass,
  onChangeClass,
}: {
  triggerType: string
  onChangeTriggerType: (v: string) => void
  triggerSettings: TriggerSettingsDraft
  onChangeTriggerSettings: (v: TriggerSettingsDraft) => void
  workflowClass: WorkflowClassValue
  onChangeClass: (v: WorkflowClassValue) => void
}) {
  const toggleChannel = (value: string, checked: boolean) => {
    const channels = checked
      ? [...triggerSettings.channels, value]
      : triggerSettings.channels.filter((c) => c !== value)
    onChangeTriggerSettings({ ...triggerSettings, channels })
  }

  return (
    <div className="space-y-4">
      <Field label="When this happens">
        <Select value={triggerType} onValueChange={onChangeTriggerType}>
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRIGGER_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {TRIGGER_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Channels">
        <div className="space-y-1.5">
          {TRIGGER_CHANNELS.map((channel) => {
            const checked = triggerSettings.channels.includes(channel.value)
            return (
              <label
                key={channel.value}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs',
                  checked ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => toggleChannel(channel.value, e.target.checked)}
                  className="size-3.5 accent-primary"
                />
                {channel.label}
              </label>
            )
          })}
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          No channels selected runs the workflow for every channel.
        </p>
      </Field>

      <Field label="Workflow class">
        <div className="space-y-1.5">
          {WORKFLOW_CLASSES.map((c) => {
            const selected = workflowClass === c.value
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => onChangeClass(c.value)}
                className={cn(
                  'relative w-full rounded-md border px-2.5 py-2 text-left transition-colors',
                  selected ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'
                )}
              >
                <div className="text-xs font-medium">{c.label}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{c.description}</div>
                {selected && <CheckIcon className="absolute top-2 right-2 size-3.5 text-primary" />}
              </button>
            )
          })}
        </div>
      </Field>
    </div>
  )
}
