/**
 * The widget New-Ticket form (widget ticket submission): a full-panel adaptation
 * of the portal `new-portal-ticket-dialog.tsx`. For an unverified visitor a
 * required Email field leads (the email-capture tier — the address the ticket's
 * updates reach); it is hidden for verified users. Then Subject + a rich Details
 * editor, followed by any admin-configured customer intake fields. Answers are
 * validated inline with the same shared validator the server enforces, so the
 * two never drift. On success it opens the created ticket's thread.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FormattedMessage, useIntl } from 'react-intl'
import { toast } from 'sonner'
import type { JSONContent } from '@tiptap/react'
import type { TicketId } from '@quackback/ids'
import type { TiptapContent } from '@/lib/shared/db-types'
import {
  validateTicketIntakeValues,
  type TicketFormField,
  type TicketIntakeError,
} from '@/lib/shared/tickets'
import { createMyWidgetTicketFn } from '@/lib/server/functions/widget-tickets'
import { getWidgetAuthHeaders } from '@/lib/client/widget-auth'
import { widgetTicketKeys, widgetTicketQueries } from '@/lib/client/queries/widget-tickets'
import { useWidgetAuth } from './widget-auth-provider'
import { RichTextEditor } from '@/components/ui/rich-text-editor'
import { VISITOR_CONVERSATION_FEATURES } from '@/components/conversation/conversation-editor-features'
import { isEmptyTiptapDoc } from '@/lib/shared/utils/is-empty-tiptap-doc'
import { useWidgetImageUpload } from '@/lib/client/hooks/use-image-upload'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/shared/spinner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const DESCRIPTION_MAX_LENGTH = 4000

interface WidgetTicketNewProps {
  /** Called with the created ticket id to open its thread. */
  onCreated: (id: TicketId) => void
}

function FieldLabel({ field }: { field: TicketFormField }) {
  return (
    <label className="text-xs font-medium text-muted-foreground">
      {field.label}
      {field.required && <span className="ms-0.5 text-destructive">*</span>}
    </label>
  )
}

export function WidgetTicketNew({ onCreated }: WidgetTicketNewProps) {
  const intl = useIntl()
  const queryClient = useQueryClient()
  const { isIdentified, sessionVersion } = useWidgetAuth()
  const { upload: uploadImage } = useWidgetImageUpload()

  const [email, setEmail] = useState('')
  const [title, setTitle] = useState('')
  const [descriptionJson, setDescriptionJson] = useState<JSONContent | undefined>(undefined)
  const [descriptionMarkdown, setDescriptionMarkdown] = useState('')
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>({})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const { data: formData, isLoading: formLoading } = useQuery(
    widgetTicketQueries.form(sessionVersion)
  )
  const fields = useMemo(() => formData?.fields ?? [], [formData])

  const setFieldValue = (key: string, value: unknown) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }))
    setFieldErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const create = useMutation({
    mutationFn: (vars: {
      title: string
      description?: string
      descriptionJson?: TiptapContent | null
      fieldValues?: Record<string, unknown>
      email?: string
    }) => createMyWidgetTicketFn({ data: vars, headers: getWidgetAuthHeaders() }),
    onSuccess: (ticket) => {
      void queryClient.invalidateQueries({ queryKey: widgetTicketKeys.all() })
      onCreated(ticket.id)
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Failed to create ticket'),
  })

  const emailRequired = !isIdentified
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const canSubmit = title.trim().length > 0 && (!emailRequired || emailValid) && !create.isPending

  const submit = () => {
    if (!canSubmit) return
    const description = descriptionMarkdown.trim()
    if (description.length > DESCRIPTION_MAX_LENGTH) {
      toast.error(
        intl.formatMessage(
          {
            id: 'widget.tickets.new.detailsTooLong',
            defaultMessage: 'Details are too long (max {max} characters).',
          },
          { max: DESCRIPTION_MAX_LENGTH }
        )
      )
      return
    }

    // Client inline validation via the same validator the server enforces.
    const result = validateTicketIntakeValues(fields, fieldValues)
    if (!result.ok) {
      setFieldErrors(
        result.errors.reduce<Record<string, string>>((acc, e: TicketIntakeError) => {
          acc[e.key] = e.message
          return acc
        }, {})
      )
      return
    }

    create.mutate({
      title: title.trim(),
      description: description || undefined,
      descriptionJson: isEmptyTiptapDoc(descriptionJson as TiptapContent | undefined)
        ? null
        : (descriptionJson as TiptapContent),
      fieldValues: Object.keys(result.values).length > 0 ? result.values : undefined,
      email: emailRequired ? email.trim() : undefined,
    })
  }

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 px-4 pb-4 pt-2">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              <FormattedMessage id="widget.tickets.new.title" defaultMessage="New ticket" />
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <FormattedMessage
                id="widget.tickets.new.subtitle"
                defaultMessage="Tell us what you need and we'll track it to resolution."
              />
            </p>
          </div>

          {emailRequired && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                <FormattedMessage id="widget.tickets.new.email" defaultMessage="Email" />
                <span className="ms-0.5 text-destructive">*</span>
              </label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={intl.formatMessage({
                  id: 'widget.tickets.new.emailPlaceholder',
                  defaultMessage: 'you@example.com',
                })}
              />
              <p className="text-[11px] text-muted-foreground/70">
                <FormattedMessage
                  id="widget.tickets.new.emailHint"
                  defaultMessage="We'll email you replies and updates on this ticket."
                />
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              <FormattedMessage id="widget.tickets.new.subject" defaultMessage="Subject" />
              <span className="ms-0.5 text-destructive">*</span>
            </label>
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={300}
              placeholder={intl.formatMessage({
                id: 'widget.tickets.new.subjectPlaceholder',
                defaultMessage: 'Summarize your request…',
              })}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              <FormattedMessage id="widget.tickets.new.details" defaultMessage="Details" />
            </label>
            <RichTextEditor
              value={descriptionJson ?? ''}
              onChange={(json, _html, markdown) => {
                setDescriptionJson(json)
                setDescriptionMarkdown(markdown)
              }}
              features={VISITOR_CONVERSATION_FEATURES}
              onImageUpload={uploadImage}
              minHeight="120px"
              placeholder={intl.formatMessage({
                id: 'widget.tickets.new.detailsPlaceholder',
                defaultMessage: 'Add anything that helps us understand the issue.',
              })}
            />
          </div>

          {formLoading ? (
            <div className="flex justify-center py-4">
              <Spinner />
            </div>
          ) : (
            fields.map((field) => (
              <div key={field.key} className="space-y-1.5">
                {field.type !== 'checkbox' && <FieldLabel field={field} />}
                {field.type === 'text' && (
                  <Input
                    value={(fieldValues[field.key] as string) ?? ''}
                    onChange={(e) => setFieldValue(field.key, e.target.value)}
                  />
                )}
                {field.type === 'long_text' && (
                  <Textarea
                    value={(fieldValues[field.key] as string) ?? ''}
                    onChange={(e) => setFieldValue(field.key, e.target.value)}
                    rows={3}
                  />
                )}
                {field.type === 'number' && (
                  <Input
                    type="number"
                    value={(fieldValues[field.key] as string) ?? ''}
                    onChange={(e) => setFieldValue(field.key, e.target.value)}
                  />
                )}
                {field.type === 'date' && (
                  <Input
                    type="date"
                    value={(fieldValues[field.key] as string) ?? ''}
                    onChange={(e) => setFieldValue(field.key, e.target.value)}
                  />
                )}
                {field.type === 'select' && (
                  <Select
                    value={(fieldValues[field.key] as string) ?? ''}
                    onValueChange={(v) => setFieldValue(field.key, v)}
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue
                        placeholder={intl.formatMessage({
                          id: 'widget.tickets.new.selectPlaceholder',
                          defaultMessage: 'Select…',
                        })}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {(field.options ?? []).map((opt) => (
                        <SelectItem key={opt} value={opt}>
                          {opt}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {field.type === 'checkbox' && (
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={fieldValues[field.key] === true}
                      onCheckedChange={(v) => setFieldValue(field.key, v === true)}
                    />
                    <span className="text-xs font-medium text-muted-foreground">
                      {field.label}
                      {field.required && <span className="ms-0.5 text-destructive">*</span>}
                    </span>
                  </label>
                )}
                {fieldErrors[field.key] && (
                  <p className="text-[11px] text-destructive">{fieldErrors[field.key]}</p>
                )}
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      <div className="shrink-0 border-t border-border/40 px-4 py-3">
        <Button className="w-full" onClick={submit} disabled={!canSubmit}>
          <FormattedMessage id="widget.tickets.new.submit" defaultMessage="Create ticket" />
        </Button>
      </div>
    </div>
  )
}
