/**
 * The ticket-types registry manager (convergence Phase 4,
 * scratchpad/convergence-design.md): the workspace's user-defined ticket
 * kinds. A type is a label + icon + color + typed field set WITHIN one of the
 * three fixed categories; the category drives behavior (cascade rules, portal
 * visibility, SLA), the type defines the fields a ticket captures.
 *
 * List + create/edit dialog (identity + the existing DnD field editor per
 * type) + archive/restore. Archive-not-delete: in-use types stay on ticket
 * history forever. Permission `ticket.manage_types` is enforced by the route
 * and re-checked by every server fn.
 */
import { useEffect, useState } from 'react'
import { useSuspenseQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  PlusIcon,
  Bars3Icon,
  TrashIcon,
  PencilSquareIcon,
  ArchiveBoxIcon,
  ArrowUturnLeftIcon,
} from '@heroicons/react/24/solid'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingsCard } from '@/components/admin/settings/settings-card'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { ColorPickerGrid, ColorHexInput, randomColor } from '@/components/shared/color-picker'
import { TICKET_TYPES } from '@/lib/shared/db-types'
import type { TicketType } from '@/lib/shared/db-types'
import { TICKET_FORM_FIELD_TYPES } from '@/lib/shared/tickets'
import type { TicketFormField, TicketFormFieldType, TicketTypeDTO } from '@/lib/shared/tickets'
import { ticketTypeLabel } from '@/components/admin/inbox/ticket-chips'
import {
  createTicketTypeFn,
  updateTicketTypeFn,
  archiveTicketTypeFn,
  restoreTicketTypeFn,
} from '@/lib/server/functions/ticket-types'
import { ticketTypesQuery } from './queries'
import {
  ticketFormFieldSchema,
  deriveFieldKey,
  uniqueFieldKey,
  findDuplicateKey,
} from './form-field-schema'

const FIELD_TYPES = TICKET_FORM_FIELD_TYPES

const FIELD_TYPE_LABEL: Record<TicketFormFieldType, string> = {
  text: 'Text',
  long_text: 'Long text',
  number: 'Number',
  select: 'Select',
  date: 'Date',
  checkbox: 'Checkbox',
}

/** Category presentation for the registry rows (label comes from the shared
 *  ticketTypeLabel so the inbox chips can't drift). */
const CATEGORY_NOTE: Record<TicketType, string> = {
  customer: 'Customers submit these from the portal and Messenger.',
  back_office: 'Internal only — customers never see them.',
  tracker: 'Internal work item. Status changes cascade to linked tickets.',
}

export function TicketTypesManager() {
  const qc = useQueryClient()
  const { data: types } = useSuspenseQuery(ticketTypesQuery)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<TicketTypeDTO | null>(null)
  const [toArchive, setToArchive] = useState<TicketTypeDTO | null>(null)

  const live = types.filter((t) => !t.archived)
  const archived = types.filter((t) => t.archived)

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ticketTypesQuery.queryKey })
  }

  async function handleArchive() {
    if (!toArchive) return
    try {
      await archiveTicketTypeFn({ data: { id: toArchive.id } })
      toast.success(`Archived "${toArchive.name}"`)
      await refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to archive type')
    } finally {
      setToArchive(null)
    }
  }

  async function handleRestore(type: TicketTypeDTO) {
    try {
      await restoreTicketTypeFn({ data: { id: type.id } })
      toast.success(`Restored "${type.name}"`)
      await refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to restore type')
    }
  }

  return (
    <SettingsCard
      title="Ticket types"
      description="Types define the fields a ticket captures. Each type belongs to a category, which drives its behavior."
      action={
        <Button
          size="sm"
          onClick={() => {
            setEditing(null)
            setDialogOpen(true)
          }}
        >
          <PlusIcon className="h-4 w-4" /> New type
        </Button>
      }
      contentClassName="p-0"
    >
      <div className="divide-y divide-border/40">
        {TICKET_TYPES.map((category) => {
          const group = live.filter((t) => t.category === category)
          if (group.length === 0) return null
          return (
            <div key={category}>
              <div className="px-4 sm:px-6 pt-4 pb-1.5">
                <p className="text-xs font-medium text-muted-foreground">
                  {ticketTypeLabel(category)}
                  <span className="font-normal"> · {CATEGORY_NOTE[category]}</span>
                </p>
              </div>
              {group.map((type) => (
                <TypeRow
                  key={type.id}
                  type={type}
                  onEdit={() => {
                    setEditing(type)
                    setDialogOpen(true)
                  }}
                  onArchive={() => setToArchive(type)}
                />
              ))}
            </div>
          )
        })}

        {archived.length > 0 && (
          <div>
            <div className="px-4 sm:px-6 pt-4 pb-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Archived
                <span className="font-normal"> · kept on ticket history, hidden from pickers.</span>
              </p>
            </div>
            {archived.map((type) => (
              <TypeRow key={type.id} type={type} onRestore={() => handleRestore(type)} />
            ))}
          </div>
        )}
      </div>

      <TypeEditorDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        type={editing}
        onSaved={refresh}
      />

      <ConfirmDialog
        open={!!toArchive}
        onOpenChange={() => setToArchive(null)}
        title="Archive type"
        description={`Archive "${toArchive?.name}"? It stays on existing tickets but leaves every picker. You can restore it later.`}
        confirmLabel="Archive"
        variant="destructive"
        onConfirm={handleArchive}
      />
    </SettingsCard>
  )
}

interface TypeRowProps {
  type: TicketTypeDTO
  onEdit?: () => void
  onArchive?: () => void
  onRestore?: () => void
}

function TypeRow({ type, onEdit, onArchive, onRestore }: TypeRowProps) {
  const fieldSummary =
    type.fields.length === 0
      ? 'No custom fields'
      : `${type.fields.length} field${type.fields.length === 1 ? '' : 's'} · ${type.fields
          .slice(0, 5)
          .map((f) => f.label)
          .join(', ')}${type.fields.length > 5 ? ', …' : ''}`
  return (
    <div className="group flex items-center gap-3 px-4 sm:px-6 py-2.5 hover:bg-muted/40">
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sm"
        style={{ backgroundColor: `${type.color}1f` }}
        aria-hidden
      >
        {type.icon ?? (
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: type.color }} />
        )}
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="truncate text-sm font-medium">{type.name}</span>
          <Badge variant="outline" className="shrink-0">
            {ticketTypeLabel(type.category)}
          </Badge>
          {type.isDefault && !type.archived && (
            <Badge variant="subtle" className="shrink-0">
              Default
            </Badge>
          )}
          {type.category !== 'customer' && (
            <Badge variant="subtle" className="shrink-0">
              Internal
            </Badge>
          )}
          {type.archived && (
            <Badge variant="subtle" className="shrink-0">
              Archived
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {fieldSummary}
          {type.ticketCount !== undefined && type.ticketCount > 0
            ? ` · ${type.ticketCount} ticket${type.ticketCount === 1 ? '' : 's'}`
            : ''}
        </p>
      </div>

      <div className="shrink-0 flex items-center justify-end gap-0.5">
        {onEdit && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground opacity-0 group-hover:opacity-100"
            onClick={onEdit}
            title="Edit type"
          >
            <PencilSquareIcon className="h-3.5 w-3.5" />
          </Button>
        )}
        {onArchive && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive"
            onClick={onArchive}
            title="Archive type"
          >
            <ArchiveBoxIcon className="h-3.5 w-3.5" />
          </Button>
        )}
        {onRestore && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground opacity-0 group-hover:opacity-100"
            onClick={onRestore}
            title="Restore type"
          >
            <ArrowUturnLeftIcon className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Type editor dialog — identity + the DnD field editor
// ---------------------------------------------------------------------------

interface TypeEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Null = creating. */
  type: TicketTypeDTO | null
  onSaved: () => Promise<void>
}

function TypeEditorDialog({ open, onOpenChange, type, onSaved }: TypeEditorDialogProps) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [category, setCategory] = useState<TicketType>('customer')
  const [icon, setIcon] = useState('')
  const [color, setColor] = useState(randomColor())
  const [intakeVisible, setIntakeVisible] = useState(true)
  const [isDefault, setIsDefault] = useState(false)
  const [fields, setFields] = useState<TicketFormField[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const editing = type !== null
  // CATEGORY LOCK: once tickets reference the type its category is fixed —
  // recategorizing would silently rewrite behavior on ticket history.
  const categoryLocked = editing && (type.ticketCount ?? 0) > 0
  // The live default can't be unset directly (the category must always resolve
  // a default); promote another type instead.
  const defaultLocked = editing && type.isDefault && !type.archived

  useEffect(() => {
    if (!open) return
    setError(null)
    if (type) {
      setName(type.name)
      setSlug(type.slug)
      setCategory(type.category)
      setIcon(type.icon ?? '')
      setColor(type.color)
      setIntakeVisible(type.intakeVisible)
      setIsDefault(type.isDefault)
      setFields(type.fields)
    } else {
      setName('')
      setSlug('')
      setCategory('customer')
      setIcon('')
      setColor(randomColor())
      setIntakeVisible(true)
      setIsDefault(false)
      setFields([])
    }
  }, [open, type])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const ordered = fields.map((f, i) => ({ ...f, order: i }))
      if (editing) {
        await updateTicketTypeFn({
          data: {
            id: type.id,
            name: name.trim(),
            slug: slug.trim() || undefined,
            ...(categoryLocked ? {} : { category }),
            icon: icon.trim() || null,
            color,
            intakeVisible,
            ...(defaultLocked ? {} : { isDefault }),
            fields: ordered,
          },
        })
        toast.success(`Saved "${name.trim()}"`)
      } else {
        await createTicketTypeFn({
          data: {
            name: name.trim(),
            category,
            slug: slug.trim() || undefined,
            icon: icon.trim() || null,
            color,
            intakeVisible,
            isDefault,
            fields: ordered,
          },
        })
        toast.success(`Created "${name.trim()}"`)
      }
      await onSaved()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save type')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit type' : 'New type'}</DialogTitle>
          <DialogDescription>Behavior comes from the category; fields are yours.</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="ticket-type-name">Name</Label>
              <Input
                id="ticket-type-name"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Bug report"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ticket-type-slug">Slug</Label>
              <Input
                id="ticket-type-slug"
                value={slug}
                maxLength={64}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="auto-generated from name"
              />
              <p className="text-[11px] text-muted-foreground">
                Lowercase letters, digits, underscores. Stable key for API + workflows.
              </p>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Category</Label>
              <Select
                value={category}
                onValueChange={(v) => setCategory(v as TicketType)}
                disabled={categoryLocked}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TICKET_TYPES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {ticketTypeLabel(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {categoryLocked && (
                <p className="text-[11px] text-muted-foreground">
                  Locked — {type.ticketCount} ticket{type.ticketCount === 1 ? '' : 's'} use this
                  type. Archive it and create a new type instead.
                </p>
              )}
            </div>
            <div className="grid grid-cols-[64px_1fr] gap-3">
              <div className="space-y-2">
                <Label htmlFor="ticket-type-icon">Icon</Label>
                <Input
                  id="ticket-type-icon"
                  value={icon}
                  maxLength={16}
                  onChange={(e) => setIcon(e.target.value)}
                  placeholder="🐛"
                  className="text-center"
                />
              </div>
              <div className="space-y-2">
                <Label>Color</Label>
                <ColorHexInput color={color} onColorChange={setColor} />
              </div>
            </div>
          </div>

          <ColorPickerGrid selectedColor={color} onColorChange={setColor} />

          <div className="flex flex-wrap gap-x-8 gap-y-3">
            {category === 'customer' && (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={intakeVisible} onCheckedChange={setIntakeVisible} />
                Show on portal + Messenger intake
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={isDefault} onCheckedChange={setIsDefault} disabled={defaultLocked} />
              Default for {ticketTypeLabel(category)} tickets
            </label>
            {defaultLocked && (
              <p className="w-full text-[11px] text-muted-foreground">
                This is the category default — set another type as default to change it.
              </p>
            )}
          </div>

          <FieldsEditor category={category} fields={fields} onChange={setFields} />

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? 'Saving…' : editing ? 'Save changes' : 'Create type'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Fields editor (the DnD editor, per type)
// ---------------------------------------------------------------------------

interface FieldsEditorProps {
  category: TicketType
  fields: TicketFormField[]
  onChange: (next: TicketFormField[]) => void
}

function FieldsEditor({ category, fields, onChange }: FieldsEditorProps) {
  // Only customer-category fields can be customer-visible; internal categories
  // force visibleToCustomer false (customers never see internal tickets).
  const internal = category !== 'customer'
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<TicketFormField | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = fields.findIndex((f) => f.key === active.id)
    const newIndex = fields.findIndex((f) => f.key === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    onChange(arrayMove(fields, oldIndex, newIndex))
  }

  function toggleVisible(field: TicketFormField, visibleToCustomer: boolean) {
    onChange(fields.map((f) => (f.key === field.key ? { ...f, visibleToCustomer } : f)))
  }

  function removeField(field: TicketFormField) {
    onChange(fields.filter((f) => f.key !== field.key))
  }

  function saveField(draft: TicketFormField) {
    const exists = fields.some((f) => f.key === draft.key)
    onChange(exists ? fields.map((f) => (f.key === draft.key ? draft : f)) : [...fields, draft])
  }

  return (
    <div className="space-y-2 rounded-lg border border-border/50 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">
          Fields — answers land in customAttributes
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setEditing(null)
            setDialogOpen(true)
          }}
        >
          <PlusIcon className="h-4 w-4" /> Add field
        </Button>
      </div>

      <FixedFieldRow label="Subject" typeLabel="Text" />
      <FixedFieldRow label="Details" typeLabel="Long text" />

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={fields.map((f) => f.key)} strategy={verticalListSortingStrategy}>
          <div className="space-y-1.5">
            {fields.map((field) => (
              <FieldRow
                key={field.key}
                field={field}
                internal={internal}
                onToggleVisible={(v) => toggleVisible(field, v)}
                onEdit={() => {
                  setEditing(field)
                  setDialogOpen(true)
                }}
                onDelete={() => removeField(field)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {fields.length === 0 && (
        <p className="py-1 text-xs text-muted-foreground">No custom fields yet.</p>
      )}

      <FieldDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        field={editing}
        internal={internal}
        existingKeys={fields.map((f) => f.key)}
        onSubmit={saveField}
      />
    </div>
  )
}

/** Built-in Subject / Details rows: always present, never editable. */
function FixedFieldRow({ label, typeLabel }: { label: string; typeLabel: string }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed border-border/50 px-3 py-2">
      <span className="w-4 shrink-0" />
      <span className="flex-1 text-sm">{label}</span>
      <Badge variant="outline">{typeLabel}</Badge>
      <Badge variant="subtle">Built-in</Badge>
    </div>
  )
}

interface FieldRowProps {
  field: TicketFormField
  internal: boolean
  onToggleVisible: (visible: boolean) => void
  onEdit: () => void
  onDelete: () => void
}

function FieldRow({ field, internal, onToggleVisible, onEdit, onDelete }: FieldRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.key,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group/field flex items-center gap-3 rounded-md border border-border/50 bg-card px-3 py-2"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="w-4 shrink-0 touch-none cursor-grab active:cursor-grabbing"
        aria-label="Reorder"
      >
        <Bars3Icon className="h-4 w-4 text-muted-foreground opacity-0 group-hover/field:opacity-100" />
      </button>

      <span className="flex-1 min-w-0 truncate text-sm">{field.label}</span>
      <Badge variant="outline">{FIELD_TYPE_LABEL[field.type]}</Badge>
      {field.required && <Badge variant="subtle">Required</Badge>}

      {internal ? (
        // Internal tickets are never shown to customers, so there is nothing to toggle.
        <span className="w-16" aria-hidden />
      ) : (
        <span className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Visible</span>
          <Switch
            checked={field.visibleToCustomer}
            onCheckedChange={onToggleVisible}
            aria-label={`Show ${field.label} to customers`}
          />
        </span>
      )}

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground opacity-0 group-hover/field:opacity-100"
        onClick={onEdit}
        title="Edit field"
      >
        <PencilSquareIcon className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground opacity-0 group-hover/field:opacity-100 hover:text-destructive"
        onClick={onDelete}
        title="Delete field"
      >
        <TrashIcon className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

interface FieldDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  field: TicketFormField | null
  internal: boolean
  existingKeys: string[]
  onSubmit: (field: TicketFormField) => void
}

function FieldDialog({
  open,
  onOpenChange,
  field,
  internal,
  existingKeys,
  onSubmit,
}: FieldDialogProps) {
  const [label, setLabel] = useState('')
  const [fieldType, setFieldType] = useState<TicketFormFieldType>('text')
  const [required, setRequired] = useState(false)
  const [visibleToCustomer, setVisibleToCustomer] = useState(true)
  const [optionsText, setOptionsText] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    if (field) {
      setLabel(field.label)
      setFieldType(field.type)
      setRequired(field.required)
      setVisibleToCustomer(field.visibleToCustomer)
      setOptionsText((field.options ?? []).join('\n'))
    } else {
      setLabel('')
      setFieldType('text')
      setRequired(false)
      setVisibleToCustomer(!internal)
      setOptionsText('')
    }
  }, [open, field, internal])

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const options =
      fieldType === 'select'
        ? optionsText
            .split('\n')
            .map((o) => o.trim())
            .filter(Boolean)
        : undefined

    // Preserve an existing field's key; derive a fresh unique one otherwise.
    const key = field ? field.key : uniqueFieldKey(deriveFieldKey(label), existingKeys)

    const draft: TicketFormField = {
      key,
      label: label.trim(),
      type: fieldType,
      required,
      visibleToCustomer: internal ? false : visibleToCustomer,
      order: field?.order ?? existingKeys.length,
      ...(options ? { options } : {}),
    }

    const parsed = ticketFormFieldSchema.safeParse(draft)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid field')
      return
    }
    const others = field ? existingKeys.filter((k) => k !== field.key) : existingKeys
    if (findDuplicateKey([...others.map((k) => ({ key: k })), { key }])) {
      setError('Another field already uses this name.')
      return
    }
    onSubmit(draft)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{field ? 'Edit field' : 'Add field'}</DialogTitle>
          <DialogDescription>
            Custom fields appear on this type&apos;s New Ticket form.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="field-label">Field name</Label>
            <Input
              id="field-label"
              value={label}
              maxLength={120}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Order number"
              required
            />
          </div>

          <div className="space-y-2">
            <Label>Type</Label>
            <Select value={fieldType} onValueChange={(v) => setFieldType(v as TicketFormFieldType)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIELD_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {FIELD_TYPE_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {fieldType === 'select' && (
            <div className="space-y-2">
              <Label htmlFor="field-options">Options</Label>
              <Textarea
                id="field-options"
                value={optionsText}
                rows={3}
                onChange={(e) => setOptionsText(e.target.value)}
                placeholder="One option per line"
              />
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={required} onCheckedChange={(v) => setRequired(v === true)} />
            Required
          </label>

          {!internal && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={visibleToCustomer}
                onCheckedChange={(v) => setVisibleToCustomer(v === true)}
              />
              Show to customers on the New Ticket form
            </label>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!label.trim()}>
              {field ? 'Save field' : 'Add field'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
