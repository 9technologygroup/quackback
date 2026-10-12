import type { IntlShape } from 'react-intl'
import type { ApprovalView } from '@/lib/server/domains/assistant/approvals.queue'
import { approvalMessages } from './approval-messages'

type People = Pick<ApprovalView, 'requestedByName' | 'onBehalfOfName'>

/** Who asked: the credential, agent or person, else the person it was for. */
export function requesterOf(view: People, intl: IntlShape): string {
  return view.requestedByName ?? view.onBehalfOfName ?? intl.formatMessage(approvalMessages.someone)
}

/** The person a request was for, when that is not whoever asked. */
export function personOf(view: People): string | null {
  const person = view.onBehalfOfName
  return person && person !== view.requestedByName ? person : null
}

/** "Claude Desktop for James Morton", or only who asked. */
export function askedBy(view: People, intl: IntlShape): string {
  const requester = requesterOf(view, intl)
  const person = personOf(view)
  return person
    ? intl.formatMessage(approvalMessages.requesterFor, { requester, person })
    : requester
}
