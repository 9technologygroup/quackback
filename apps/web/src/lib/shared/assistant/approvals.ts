/**
 * How an approval reads to the agents and API clients that follow it: one
 * status word per state, and the in-app page a person opens to decide it.
 */
import { isValidTypeId } from '@quackback/ids'

/**
 * The states an approval moves through, as clients read them. `pending` waits
 * for a person; `approved` and `rejected` are decisions; `applied` and
 * `failed` are how an approved change ran, and `undone` is an applied change a
 * person later reverted; `expired` timed out; `superseded` was replaced by a
 * newer request that combines it.
 */
export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'superseded',
  'applied',
  'undone',
  'failed',
] as const

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

/** The Approvals page, which opens on the request its `id` names. */
const APPROVALS_PAGE = '/admin/approvals'

/** The in-app page a person opens to decide an approval. */
export function approvalPath(approvalId: string): string {
  return `${APPROVALS_PAGE}?id=${encodeURIComponent(approvalId)}`
}

/**
 * The approval id in a reference to one: the id itself, or the url (or path)
 * of its page, `/admin/approvals?id=<id>`. The older `/admin/approvals/<id>`
 * form is read too. Null for anything else.
 */
export function approvalIdFromReference(reference: string): string | null {
  let candidate = reference.trim()
  if (/^https?:\/\//i.test(candidate) || candidate.startsWith('/')) {
    let url: URL
    try {
      url = new URL(candidate, 'http://localhost')
    } catch {
      return null
    }
    const path = url.pathname.replace(/\/$/, '')
    if (path === APPROVALS_PAGE) candidate = url.searchParams.get('id') ?? ''
    else if (path.startsWith(`${APPROVALS_PAGE}/`))
      candidate = path.slice(APPROVALS_PAGE.length + 1)
    else return null
  }
  return isValidTypeId(candidate, 'assistant_action') ? candidate : null
}
