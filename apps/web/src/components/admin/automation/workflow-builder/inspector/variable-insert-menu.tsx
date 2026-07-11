/**
 * The "insert variable" dropdown shared by every inspector editor that lets
 * an admin insert a `{key}` workflow-variable token without hand-typing it:
 * block-body-field.tsx's rich-text prompt (one menu, inserted into the body)
 * and call-connector-editor.tsx's per-input mapping (one menu per declared
 * input). Both fed the same WORKFLOW_VARIABLE_CATALOGUE and only ever differ
 * in their trigger affordance and what "insert" does with the picked key —
 * both left entirely to the caller via `trigger` and `onInsert`.
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { WORKFLOW_VARIABLE_CATALOGUE } from '@/lib/shared/workflows/message-variables'

export function VariableInsertMenu({
  onInsert,
  trigger,
  align = 'start',
}: {
  /** Called with the picked catalogue key (e.g. `first_name`) — the caller
   *  owns turning that into an inserted `{key|fallback}` token, a rich-text
   *  insertion, or a plain string append, whichever its own field needs. */
  onInsert: (key: string) => void
  /** The dropdown's trigger element, rendered via `asChild` — callers own
   *  their own button styling/label/aria-label since the two current
   *  callers differ on all three. */
  trigger: React.ReactNode
  align?: 'start' | 'end'
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        {WORKFLOW_VARIABLE_CATALOGUE.map((v) => (
          <DropdownMenuItem key={v.key} onSelect={() => onInsert(v.key)}>
            {v.label}
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
              {`{${v.key}}`}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
