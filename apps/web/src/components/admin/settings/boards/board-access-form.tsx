import { useForm } from 'react-hook-form'
import { Button } from '@/components/ui/button'
import { FormError } from '@/components/shared/form-error'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@/components/ui/form'
import { useUpdateBoardAccess } from '@/lib/client/mutations'
import { GlobeAltIcon, LockClosedIcon, UsersIcon, TagIcon } from '@heroicons/react/24/solid'
import type { BoardId } from '@quackback/ids'
import type { BoardAudience } from '@/lib/shared/db-types'

/**
 * Board visibility form. Backed by `audience` (BoardAudience union).
 *
 * Exposes three of the four visibility kinds as radio buttons (public /
 * authenticated / team). When the board's stored audience is
 * `{ kind: 'segments' }`, the form shows a read-only banner directing the
 * admin to manage the segment list on the Segments admin page.
 *
 * Post moderation is workspace-wide (Settings → Moderation), not per-board.
 *
 * Submit calls `updateBoardAccessFn` (admin-only, audited) — distinct from
 * the general board update path so members can't change board visibility.
 */

interface Board {
  id: BoardId
  audience: BoardAudience
}

interface BoardAccessFormProps {
  board: Board
}

type RadioVisibility = 'public' | 'authenticated' | 'team'

interface FormValues {
  visibility: RadioVisibility
}

function radioVisibility(audience: BoardAudience): RadioVisibility | null {
  switch (audience.kind) {
    case 'public':
      return 'public'
    case 'authenticated':
      return 'authenticated'
    case 'team':
      return 'team'
    case 'segments':
      return null // not representable in this form
  }
}

function formValueToAudience(value: RadioVisibility): BoardAudience {
  return { kind: value }
}

export function BoardAccessForm({ board }: BoardAccessFormProps) {
  const mutation = useUpdateBoardAccess()
  const initial = radioVisibility(board.audience)
  const isSegmentAudience = initial === null

  const form = useForm<FormValues>({
    defaultValues: {
      visibility: initial ?? 'public', // placeholder; submit is gated by isSegmentAudience
    },
  })

  async function onSubmit(data: FormValues) {
    // Defensive: never overwrite a segments-audience board from this form.
    // The form value is 'public'/'authenticated'/'team' — submitting would
    // drop the segmentIds. Disabled in the UI for audience, but belt-and-
    // braces here too.
    if (isSegmentAudience) return

    mutation.mutate({
      boardId: board.id,
      audience: formValueToAudience(data.visibility),
    })
  }

  if (isSegmentAudience) {
    const segmentIds = board.audience.kind === 'segments' ? board.audience.segmentIds : []
    return (
      <div className="rounded-lg border border-border/50 bg-muted/30 p-4">
        <div className="flex items-start gap-3">
          <TagIcon className="h-4 w-4 text-muted-foreground mt-1" />
          <div className="space-y-1">
            <p className="font-medium text-sm">Restricted to specific segments</p>
            <p className="text-xs text-muted-foreground">
              This board is currently visible only to members of {segmentIds.length} segment
              {segmentIds.length === 1 ? '' : 's'}. Edit the segment list from Settings → Access →
              Segments, or switch this board to one of the standard visibility tiers via the API /
              updateBoardAccessFn.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {mutation.isError && <FormError message={mutation.error?.message ?? 'An error occurred'} />}

        {/* Board Visibility */}
        <FormField
          control={form.control}
          name="visibility"
          render={({ field }) => (
            <FormItem className="space-y-4">
              <div>
                <FormLabel className="text-base">Board Visibility</FormLabel>
                <FormDescription>Control who can see this board on your portal</FormDescription>
              </div>
              <FormControl>
                <RadioGroup
                  onValueChange={(value) => field.onChange(value as RadioVisibility)}
                  value={field.value}
                  className="grid gap-3"
                >
                  <Label
                    htmlFor="visibility-public"
                    className="flex items-start gap-3 rounded-lg border p-4 cursor-pointer hover:bg-muted/50 [&:has([data-state=checked])]:border-primary [&:has([data-state=checked])]:bg-primary/5"
                  >
                    <RadioGroupItem value="public" id="visibility-public" className="mt-0.5" />
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <GlobeAltIcon className="h-4 w-4" />
                        <span className="font-medium">Public</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Anyone can view this board on your portal, including unsigned visitors.
                        Signed-in users can vote, comment, and submit feedback.
                      </p>
                    </div>
                  </Label>
                  <Label
                    htmlFor="visibility-authenticated"
                    className="flex items-start gap-3 rounded-lg border p-4 cursor-pointer hover:bg-muted/50 [&:has([data-state=checked])]:border-primary [&:has([data-state=checked])]:bg-primary/5"
                  >
                    <RadioGroupItem
                      value="authenticated"
                      id="visibility-authenticated"
                      className="mt-0.5"
                    />
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <UsersIcon className="h-4 w-4" />
                        <span className="font-medium">Authenticated</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Any signed-in portal user can view this board. Hidden from anonymous
                        visitors and search indexes.
                      </p>
                    </div>
                  </Label>
                  <Label
                    htmlFor="visibility-team"
                    className="flex items-start gap-3 rounded-lg border p-4 cursor-pointer hover:bg-muted/50 [&:has([data-state=checked])]:border-primary [&:has([data-state=checked])]:bg-primary/5"
                  >
                    <RadioGroupItem value="team" id="visibility-team" className="mt-0.5" />
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <LockClosedIcon className="h-4 w-4" />
                        <span className="font-medium">Team only</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Only admins and team members can view this board
                      </p>
                    </div>
                  </Label>
                </RadioGroup>
              </FormControl>
            </FormItem>
          )}
        />

        <div className="flex justify-end">
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving...' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Form>
  )
}
