/** The wait step editor, ported unchanged from the old popover version. */
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Field } from './shared'
import { WAIT_UNITS, secondsToWaitParts, type WaitUnit } from '../../workflow-graph'

export function WaitEditor({
  seconds,
  onChange,
}: {
  seconds: number
  onChange: (seconds: number) => void
}) {
  const { amount, unit } = secondsToWaitParts(seconds)
  const unitSeconds = (u: WaitUnit) => WAIT_UNITS.find((w) => w.value === u)!.seconds

  const setAmount = (raw: string) => {
    const n = Math.max(0, Math.round(Number(raw)))
    if (Number.isFinite(n)) onChange(n * unitSeconds(unit))
  }

  return (
    <div className="space-y-2">
      <Field label="Wait for">
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            min={0}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
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
      </Field>
      <p className="text-xs text-muted-foreground">
        The run pauses here, then continues. A reply or close ends the wait.
      </p>
    </div>
  )
}
