/**
 * The `call_connector` step editor: pick an existing ENABLED data connector,
 * then map each of its declared inputs to a `{key|fallback}` template string
 * (the same workflow-variable token syntax message blocks use — see
 * lib/shared/workflows/interpolate.ts + WORKFLOW_VARIABLE_CATALOGUE),
 * plus an optional per-node timeout override. The connector's own builtins
 * ({customer.email} etc.) are NOT offered here — those resolve inside
 * executeConnector from the conversation directly, never authored (see
 * action.executor.ts's executeCallConnectorNode).
 *
 * Switching connectors resets `params`: a template mapped against one
 * connector's inputs is meaningless against another's, and stale entries
 * would silently never be read (the interpolator only ever consults the
 * NEWLY selected connector's declared input names).
 */
import { useQuery } from '@tanstack/react-query'
import { PlusIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { connectorsQuery } from '@/lib/client/queries/connectors'
import { WORKFLOW_VARIABLE_CATALOGUE } from '@/lib/shared/workflows/message-variables'
import { ClampedIntInput, Field } from './shared'
import {
  MAX_CALL_CONNECTOR_TIMEOUT_MS,
  MIN_CALL_CONNECTOR_TIMEOUT_MS,
  isNeedsSetupRef,
  type TreeStep,
} from '../../workflow-graph'

/** Seed value when the timeout-override switch is first turned on — mirrors
 *  the connector row's own DEFAULT_TIMEOUT_MS (connector.service.ts), which
 *  isn't itself exported client-side; re-declared here the same way
 *  LET_ASSISTANT_DEFAULT_KEY etc. re-declare a server literal rather than
 *  import it. */
const DEFAULT_TIMEOUT_OVERRIDE_MS = 10000

export function CallConnectorEditor({
  step,
  onChange,
}: {
  step: Extract<TreeStep, { kind: 'call_connector' }>
  onChange: (step: TreeStep) => void
}) {
  const { data: connectors } = useQuery(connectorsQuery())
  // Only a connector that can actually run: listConnectors() (behind
  // connectorsQuery) returns every connector regardless of enabled/status,
  // unlike listEnabledConnectors — this picker only ever offers ones the
  // engine won't immediately reject as 'unavailable'.
  const runnable = (connectors ?? []).filter((c) => c.enabled && c.status === 'active')
  const selectedId = isNeedsSetupRef(step.connectorId) ? '' : step.connectorId
  const selected = runnable.find((c) => c.id === selectedId)

  const setParam = (name: string, value: string) =>
    onChange({ ...step, params: { ...step.params, [name]: value } })

  return (
    <div className="space-y-3">
      <Field label="Connector">
        <Select
          value={selectedId}
          onValueChange={(connectorId) => onChange({ ...step, connectorId, params: {} })}
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue placeholder="Choose a connector" />
          </SelectTrigger>
          <SelectContent>
            {runnable.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {connectors && runnable.length === 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            No enabled connectors yet — add one under Settings → AI &amp; Automation → Connectors.
          </p>
        )}
        {step.connectorId && !isNeedsSetupRef(step.connectorId) && connectors && !selected && (
          <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-500">
            This connector is no longer enabled — choose another.
          </p>
        )}
      </Field>

      {selected && selected.inputs.length > 0 && (
        <div className="space-y-2.5">
          {selected.inputs.map((input) => (
            <Field key={input.name} label={`${input.name}${input.required ? ' (required)' : ''}`}>
              <div className="flex items-center gap-1.5">
                <Input
                  value={step.params[input.name] ?? ''}
                  onChange={(e) => setParam(input.name, e.target.value)}
                  placeholder="e.g. {first_name|there}"
                  className="h-8 text-sm"
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Insert variable into ${input.name}`}
                    >
                      <PlusIcon className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {WORKFLOW_VARIABLE_CATALOGUE.map((v) => (
                      <DropdownMenuItem
                        key={v.key}
                        onSelect={() =>
                          setParam(input.name, `${step.params[input.name] ?? ''}{${v.key}|}`)
                        }
                      >
                        {v.label}
                        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                          {`{${v.key}}`}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {input.description && (
                <p className="mt-1 text-[11px] text-muted-foreground">{input.description}</p>
              )}
            </Field>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between rounded-md border p-2.5">
        <div>
          <Label className="text-xs">Override timeout</Label>
          <p className="text-[11px] text-muted-foreground">
            Otherwise uses the connector's own configured timeout.
          </p>
        </div>
        <Switch
          aria-label="Override timeout"
          checked={step.timeoutMs !== undefined}
          onCheckedChange={(on) =>
            onChange({ ...step, timeoutMs: on ? DEFAULT_TIMEOUT_OVERRIDE_MS : undefined })
          }
        />
      </div>
      {step.timeoutMs !== undefined && (
        <Field label="Timeout">
          <div className="flex items-center gap-1.5">
            <ClampedIntInput
              value={step.timeoutMs}
              min={MIN_CALL_CONNECTOR_TIMEOUT_MS}
              max={MAX_CALL_CONNECTOR_TIMEOUT_MS}
              onCommit={(timeoutMs) => onChange({ ...step, timeoutMs })}
              className="h-8 w-24 text-sm"
            />
            <span className="text-xs text-muted-foreground">ms</span>
          </div>
        </Field>
      )}

      <p className="text-xs text-muted-foreground">
        Continues on its default path when the call succeeds. If it fails (rate limited, blocked
        host, HTTP error, network error, invalid inputs, or the connector is unavailable), the run
        instead follows the “On failure” path below.
      </p>
    </div>
  )
}
