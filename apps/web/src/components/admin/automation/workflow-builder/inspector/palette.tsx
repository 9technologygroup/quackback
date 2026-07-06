/**
 * The step palette: shown in the inspector when a "+" connector is active
 * instead of a step. Grouped by Logic (condition/branch/wait) and Actions
 * (all 9 action types); clicking an item inserts that step at the active
 * insertion point and selects it.
 */
import type { ComponentType } from 'react'
import { ClockIcon, FunnelIcon, ShareIcon } from '@heroicons/react/24/outline'
import { ACTION_ICONS, GATE_TINT, STEP_TINT } from '../canvas'
import { ACTION_LABELS, ACTION_TYPES, type ActionType, type TreeStep } from '../../workflow-graph'

interface PaletteItem {
  label: string
  icon: ComponentType<{ className?: string }>
  tint: string
  onSelect: () => void
}

export function StepPalette({
  onInsert,
}: {
  onInsert: (kind: TreeStep['kind'], actionType?: ActionType) => void
}) {
  const logic: PaletteItem[] = [
    {
      label: 'Condition',
      icon: FunnelIcon,
      tint: GATE_TINT,
      onSelect: () => onInsert('condition'),
    },
    {
      label: 'Branch into paths',
      icon: ShareIcon,
      tint: GATE_TINT,
      onSelect: () => onInsert('branch'),
    },
    { label: 'Wait', icon: ClockIcon, tint: STEP_TINT, onSelect: () => onInsert('wait') },
  ]
  const actions: PaletteItem[] = ACTION_TYPES.map((type) => ({
    label: ACTION_LABELS[type],
    icon: ACTION_ICONS[type],
    tint: STEP_TINT,
    onSelect: () => onInsert('action', type),
  }))

  return (
    <div className="space-y-4 p-3">
      <PaletteGroup label="Logic" items={logic} />
      <PaletteGroup label="Actions" items={actions} />
    </div>
  )
}

function PaletteGroup({ label, items }: { label: string; items: PaletteItem[] }) {
  return (
    <div>
      <div className="mb-1 px-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="space-y-0.5">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={item.onSelect}
            className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-xs hover:bg-muted/60"
          >
            <span
              className={`flex size-6 shrink-0 items-center justify-center rounded-md ${item.tint}`}
            >
              <item.icon className="size-3.5" />
            </span>
            {item.label}
          </button>
        ))}
      </div>
    </div>
  )
}
