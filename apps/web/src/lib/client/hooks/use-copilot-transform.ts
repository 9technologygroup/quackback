import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { useSseTurn } from './use-sse-turn'
import { extractHttpErrorMessage, GENERIC_ERROR } from '@/lib/client/utils/http-error'
import { itemRefBody } from '@/lib/client/copilot-events'
import type { InboxItemRef } from '@/lib/shared/inbox/items'
import {
  TRANSFORM_EVENTS,
  type TransformKind,
  type TransformDeltaPayload,
  type TransformFinalPayload,
  type TransformErrorPayload,
} from '@/lib/shared/assistant/copilot-contract'

/** Shared streamed rewrite runner for Copilot answers and composer drafts. */
export function useCopilotTransform(item: InboxItemRef) {
  const { start, stop } = useSseTurn()

  useEffect(() => stop, [stop])

  return useCallback(
    async (transform: TransformKind, text: string): Promise<string | null> => {
      let result = ''
      let ok = true
      await start({
        url: '/api/admin/assistant/transform',
        body: { ...itemRefBody(item), text, transform },
        handlers: {
          [TRANSFORM_EVENTS.delta]: (data) => {
            result += (data as TransformDeltaPayload).text
          },
          [TRANSFORM_EVENTS.final]: (data) => {
            const final = data as TransformFinalPayload
            if (final.text) result = final.text
          },
          [TRANSFORM_EVENTS.error]: (data) => {
            ok = false
            toast.error((data as TransformErrorPayload).message || GENERIC_ERROR)
          },
        },
        onHttpError: async (res) => {
          ok = false
          toast.error(await extractHttpErrorMessage(res))
        },
        onAbort: () => {
          ok = false
        },
        onError: () => {
          ok = false
          toast.error(GENERIC_ERROR)
        },
      })
      return ok && result ? result : null
    },
    [item, start]
  )
}
