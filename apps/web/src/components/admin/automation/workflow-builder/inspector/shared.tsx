/** Small shared bits for the inspector's step editors: a labeled field
 *  wrapper, an id/name entity select, a clamped-int number input, and the
 *  amount+unit duration input, all lifted from the old popover editors
 *  verbatim (ClampedIntInput is new; see its own doc comment). */
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  isNeedsSetupRef,
  WAIT_UNITS,
  secondsToWaitParts,
  type WaitUnit,
} from '../../workflow-graph'
import type { EntityOption } from '../entities'

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

export function EntitySelect({
  value,
  placeholder,
  items,
  onChange,
}: {
  value: string
  placeholder: string
  items: EntityOption[]
  onChange: (id: string) => void
}) {
  // A template's needs-setup placeholder reads as "nothing chosen yet" so the
  // trigger shows the placeholder text instead of rendering blank.
  const selected = isNeedsSetupRef(value) ? '' : value
  return (
    <Select value={selected} onValueChange={onChange}>
      <SelectTrigger size="sm" className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.id} value={item.id}>
            {item.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * A number input for a bounded integer that clamps on commit, not on every
 * keystroke. Clamping on keystroke fights the user two ways: clearing the
 * field snaps straight to the min (then typing "5" reads as "5" appended to
 * that min, e.g. "15"), and overshooting mid-type clamps to the max before
 * they finish typing the intended value. Instead, the field free-types while
 * focused (any raw string, including empty or out-of-range) and only clamps
 * to `[min, max]` on blur or Enter, at which point `onCommit` fires with the
 * clamped result and the field's display catches up to it.
 *
 * Shared by the trigger inspector's frequency-cap days/count inputs
 * (trigger-editor.tsx) and DurationInput below, which previously each wrote
 * their own near-identical clamp expression.
 */
export function ClampedIntInput({
  value,
  min,
  max,
  onCommit,
  className,
}: {
  value: number
  min: number
  max: number
  onCommit: (value: number) => void
  className?: string
}) {
  // null = not mid-edit; the field shows `value`. A non-null string is the
  // in-progress, not-yet-clamped keystroke state.
  const [draft, setDraft] = useState<string | null>(null)

  const commit = () => {
    if (draft === null) return
    const parsed = Math.round(Number(draft))
    const clamped = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : min
    setDraft(null)
    if (clamped !== value) onCommit(clamped)
  }

  return (
    <Input
      type="number"
      min={min}
      max={max === Infinity ? undefined : max}
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      className={className}
    />
  )
}

/** The amount+unit duration input, shared by the wait step (wait-editor.tsx)
 *  and the snooze action's relative-duration mode (action-editor.tsx) so the
 *  two pick the same way. The amount field commits its clamp on blur/Enter
 *  via ClampedIntInput; the unit select still applies immediately (it isn't
 *  free-typed, so there's nothing to fight). */
export function DurationInput({
  seconds,
  onChange,
}: {
  seconds: number
  onChange: (seconds: number) => void
}) {
  const { amount, unit } = secondsToWaitParts(seconds)
  const unitSeconds = (u: WaitUnit) => WAIT_UNITS.find((w) => w.value === u)!.seconds

  return (
    <div className="flex items-center gap-1.5">
      <ClampedIntInput
        value={amount}
        min={0}
        max={Infinity}
        onCommit={(next) => onChange(next * unitSeconds(unit))}
        className="h-8 w-20 text-sm"
      />
      <Select value={unit} onValueChange={(u) => onChange(amount * unitSeconds(u as WaitUnit))}>
        <SelectTrigger size="sm" className="flex-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WAIT_UNITS.map((u) => (
            <SelectItem key={u.value} value={u.value}>
              {u.plural}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
