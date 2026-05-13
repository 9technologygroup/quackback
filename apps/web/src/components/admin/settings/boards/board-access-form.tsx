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
import { useUpdateBoard } from '@/lib/client/mutations'
import { GlobeAltIcon, LockClosedIcon, UsersIcon } from '@heroicons/react/24/solid'
import type { BoardId } from '@quackback/ids'
import type { BoardAudience } from '@/lib/shared/db-types'

/**
 * Board visibility form. Now backed by `audience` (BoardAudience union).
 *
 * Three of the four audience kinds are exposed here: public / authenticated /
 * team. The segments[] variant requires picking segment ids and is wired
 * separately in the segments admin page (which writes through
 * updateBoardAccessFn). Keeping this form simple preserves the existing
 * three-option UX for binary-toggle workflows.
 */

interface Board {
  id: BoardId
  audience: BoardAudience
}

interface BoardAccessFormProps {
  board: Board
}

type SimpleVisibility = 'public' | 'authenticated' | 'team'

interface FormValues {
  visibility: SimpleVisibility
}

function audienceToFormValue(audience: BoardAudience): SimpleVisibility {
  switch (audience.kind) {
    case 'public':
      return 'public'
    case 'authenticated':
      return 'authenticated'
    case 'team':
    case 'segments': // segments boards collapse to 'team' in this binary view
      return 'team'
  }
}

function formValueToAudience(value: SimpleVisibility): BoardAudience {
  return { kind: value }
}

export function BoardAccessForm({ board }: BoardAccessFormProps) {
  const mutation = useUpdateBoard()

  const form = useForm<FormValues>({
    defaultValues: {
      visibility: audienceToFormValue(board.audience),
    },
  })

  async function onSubmit(data: FormValues) {
    mutation.mutate({
      id: board.id,
      audience: formValueToAudience(data.visibility),
    })
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
                  onValueChange={(value) => field.onChange(value as SimpleVisibility)}
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
                      <p className="text-sm text-muted-foreground">
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
                      <p className="text-sm text-muted-foreground">
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
                      <p className="text-sm text-muted-foreground">
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
