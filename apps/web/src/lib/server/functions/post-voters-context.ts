/**
 * Read-side server fn backing the portal vote-management tools (the voters
 * list behind the avatar stack + voters modal).
 *
 * The admin voters list (fetchPostVotersFn) gates on post.view_private, but a
 * narrowly-scoped portal team member can hold post.vote_on_behalf without
 * post.view_private. This fn gates on the exact capability the vote tools need
 * — post.vote_on_behalf, the same key that already guards the proxy-vote,
 * remove-vote, and voter-subscription mutations — so query enablement lines up
 * 1:1 with the tools' render gate and the public portal post payload never has
 * to grow a voters field (voters are fetched here, permission-gated, only when
 * a vote manager loads the page). It returns the same shape as
 * fetchPostVotersFn so the shared voters components read either source
 * interchangeably.
 */

import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import { type PostId } from '@quackback/ids'
import { PERMISSIONS } from '@/lib/shared/permissions'
import { requireAuth } from './auth-helpers'
import { getPostVoters } from '@/lib/server/domains/posts/post.voting'
import { toIsoString } from '@/lib/shared/utils'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'post-voters-context' })

/**
 * The voters for a post, resolved for a holder of post.vote_on_behalf. Same
 * projection as the admin fetchPostVotersFn (anonymous voters already
 * sanitized by getPostVoters), differing only in the permission gate.
 */
export const listPostVotersForVoteManagerFn = createServerFn({ method: 'GET' })
  .validator(z.object({ postId: z.string() }))
  .handler(async ({ data }) => {
    await requireAuth({ permission: PERMISSIONS.POST_VOTE_ON_BEHALF })
    try {
      const voters = await getPostVoters(data.postId as PostId)
      return voters.map((v) => ({
        ...v,
        createdAt: toIsoString(v.createdAt as Date | string),
      }))
    } catch (error) {
      log.error({ err: error, post_id: data.postId }, 'list post voters (vote manager) failed')
      throw error
    }
  })
