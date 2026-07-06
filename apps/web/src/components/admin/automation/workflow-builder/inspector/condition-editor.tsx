/**
 * One level of "all/any of these rules" condition editing, ported unchanged
 * from the old popover editor. Nested groups (or a value that doesn't fit
 * the field's kind) are preserved as-is and stay editable only via JSON mode.
 */
import { PlusIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { cn } from '@/lib/shared/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  CONDITION_FIELD_LIST,
  CONDITION_FIELD_META,
  OPERATOR_LABELS,
  OPERATORS_BY_KIND,
  VALUELESS_OPERATORS,
  conditionToDraft,
  defaultRule,
  draftToCondition,
  type ConditionOperator,
  type ConditionRuleDraft,
  type GraphCondition,
} from '../../workflow-graph'

export function ConditionEditor({
  subject,
  condition,
  onChange,
}: {
  subject: string
  condition: GraphCondition
  onChange: (condition: GraphCondition) => void
}) {
  const draft = conditionToDraft(condition)

  if (draft.kind === 'advanced') {
    return (
      <p className="text-xs text-muted-foreground">
        This condition nests groups the visual editor can&apos;t show. Use JSON mode to change it.
      </p>
    )
  }

  const commit = (next: typeof draft) => onChange(draftToCondition(next))
  const updateRule = (index: number, rule: ConditionRuleDraft) =>
    commit({ ...draft, rules: draft.rules.map((r, i) => (i === index ? rule : r)) })

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>{subject}</span>
        {draft.rules.length > 1 && (
          <>
            <Select
              value={draft.mode}
              onValueChange={(mode) => commit({ ...draft, mode: mode as 'all' | 'any' })}
            >
              <SelectTrigger size="xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">all</SelectItem>
                <SelectItem value="any">any</SelectItem>
              </SelectContent>
            </Select>
            <span>of these match</span>
          </>
        )}
      </div>

      {draft.rules.map((rule, i) => (
        <RuleRow
          key={i}
          rule={rule}
          onChange={(r) => updateRule(i, r)}
          onRemove={() => commit({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })}
        />
      ))}

      {draft.rules.length === 0 && (
        <p className="text-xs text-muted-foreground">No rules yet, so everything matches.</p>
      )}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={() => commit({ ...draft, rules: [...draft.rules, defaultRule()] })}
      >
        <PlusIcon className="size-3.5" /> Add rule
      </Button>
    </div>
  )
}

function RuleRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: ConditionRuleDraft
  onChange: (rule: ConditionRuleDraft) => void
  onRemove: () => void
}) {
  const meta = CONDITION_FIELD_META[rule.field]
  const operators = OPERATORS_BY_KIND[meta.kind]
  const needsValue = !VALUELESS_OPERATORS.has(rule.op)

  const setField = (field: ConditionRuleDraft['field']) => {
    const fieldMeta = CONDITION_FIELD_META[field]
    const op = OPERATORS_BY_KIND[fieldMeta.kind][0]!
    const value =
      fieldMeta.kind === 'choice'
        ? (fieldMeta.options?.[0]?.value ?? '')
        : fieldMeta.kind === 'boolean'
          ? 'true'
          : ''
    onChange({ field, op, value })
  }

  const setOp = (op: ConditionOperator) =>
    onChange({ ...rule, op, value: VALUELESS_OPERATORS.has(op) ? '' : rule.value })

  return (
    <div className="space-y-1.5 rounded-md border bg-muted/30 p-2">
      <div className="flex items-center gap-1.5">
        <Select
          value={rule.field}
          onValueChange={(f) => setField(f as ConditionRuleDraft['field'])}
        >
          <SelectTrigger size="xs" className="min-w-0 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONDITION_FIELD_LIST.map((f) => (
              <SelectItem key={f} value={f}>
                {CONDITION_FIELD_META[f].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          aria-label="Remove rule"
          onClick={onRemove}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
        >
          <XMarkIcon className="size-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-1.5">
        <Select value={rule.op} onValueChange={(op) => setOp(op as ConditionOperator)}>
          <SelectTrigger
            size="xs"
            className={cn('min-w-0', needsValue ? 'w-32 shrink-0' : 'flex-1')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {operators.map((op) => (
              <SelectItem key={op} value={op}>
                {OPERATOR_LABELS[op]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {needsValue && <RuleValueEditor rule={rule} onChange={onChange} />}
      </div>
    </div>
  )
}

function RuleValueEditor({
  rule,
  onChange,
}: {
  rule: ConditionRuleDraft
  onChange: (rule: ConditionRuleDraft) => void
}) {
  const meta = CONDITION_FIELD_META[rule.field]
  const set = (value: string) => onChange({ ...rule, value })

  if (meta.kind === 'choice') {
    return (
      <Select value={rule.value} onValueChange={set}>
        <SelectTrigger size="xs" className="min-w-0 flex-1">
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {(meta.options ?? []).map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }
  if (meta.kind === 'boolean') {
    return (
      <Select value={rule.value || 'true'} onValueChange={set}>
        <SelectTrigger size="xs" className="min-w-0 flex-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">Yes</SelectItem>
          <SelectItem value="false">No</SelectItem>
        </SelectContent>
      </Select>
    )
  }
  return (
    <Input
      type={meta.kind === 'number' ? 'number' : 'text'}
      value={rule.value}
      onChange={(e) => set(e.target.value)}
      placeholder={meta.placeholder}
      className="h-6 min-w-0 flex-1 px-1.5 text-xs"
    />
  )
}
