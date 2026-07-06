/** Small shared bits for the inspector's step editors: a labeled field
 *  wrapper and an id/name entity select, both lifted from the old popover
 *  editors verbatim. */
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { isNeedsSetupRef } from '../../workflow-graph'
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
