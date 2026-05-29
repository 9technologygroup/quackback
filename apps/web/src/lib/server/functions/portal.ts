import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import {
  type PostId,
  type PrincipalId,
  type BoardId,
  type RoadmapId,
  type SegmentId,
  type StatusId,
  type TagId,
  type UserId,
} from '@quackback/ids'
import type { BoardSettings } from '@/lib/server/db'
import {
  getOptionalAuth,
  hasAuthCredentials,
  policyActorFromAuth,
  requireAuth,
} from './auth-helpers'
import { NotFoundError } from '@/lib/shared/errors'
import { isTeamMember } from '@/lib/shared/roles'
import { db, principal as principalTable, user as userTable, eq, inArray } from '@/lib/server/db'
import { getPublicUrlOrNull } from '@/lib/server/storage/s3'
import {
  listPublicBoardsWithStats,
  getPublicBoardBySlug,
} from '@/lib/server/domains/boards/board.public'
import {
  listPublicPosts,
  listPublicPostsWithVotesAndAvatars,
  getVotedPostIdsByUserId,
} from '@/lib/server/domains/posts/post.public'
import { getPublicPostDetail } from '@/lib/server/domains/posts/post.public.detail'
import { getPostMergeInfo, getMergedPosts } from '@/lib/server/domains/posts/post.merge'
import { listPublicStatuses } from '@/lib/server/domains/statuses/status.service'
import { listPublicTags } from '@/lib/server/domains/tags/tag.service'
import { getSubscriptionStatus } from '@/lib/server/domains/subscriptions/subscription.service'
import { listPublicRoadmaps } from '@/lib/server/domains/roadmaps/roadmap.service'
import { getPublicRoadmapPosts } from '@/lib/server/domains/roadmaps/roadmap.query'
import { resolvePortalAccessForRequest } from './portal-access'

// Schemas
const sortSchema = z.enum(['top', 'new', 'trending'])

const fetchPublicPostsSchema = z.object({
  boardSlug: z.string().optional(),
  search: z.string().optional(),
  sort: sortSchema,
})

const fetchPortalDataSchema = z.object({
  boardSlug: z.string().optional(),
  search: z.string().optional(),
  sort: sortSchema,
  statusSlugs: z.array(z.string()).optional(),
  tagIds: z.array(z.string()).optional(),
  userId: z.string().optional(),
  minVotes: z.number().int().min(1).optional(),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => !Number.isNaN(new Date(s).getTime()), 'Invalid calendar date')
    .optional(),
  responded: z.enum(['responded', 'unresponded']).optional(),
})

export const getPrincipalIdForUser = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ userId: z.string() }))
  .handler(async ({ data }): Promise<PrincipalId | null> => {
    console.log(`[fn:portal] getPrincipalIdForUser: userId=${data.userId}`)
    try {
      const record = await db.query.principal.findFirst({
        where: eq(principalTable.userId, data.userId as UserId),
      })
      return record?.id ?? null
    } catch (error) {
      console.error(`[fn:portal] getPrincipalIdForUser failed:`, error)
      throw error
    }
  })

export const fetchPortalData = createServerFn({ method: 'GET' })
  .inputValidator(fetchPortalDataSchema)
  .handler(async ({ data }) => {
    console.log(`[fn:portal] fetchPortalData: boardSlug=${data.boardSlug}, sort=${data.sort}`)

    // Outer gate: a private portal serves no boards/posts/statuses/tags to a
    // caller the portal-access resolver denies. The per-board audience filter
    // below stays as the inner layer for granted callers.
    const access = await resolvePortalAccessForRequest()
    if (!access.granted) {
      console.log(`[fn:portal] fetchPortalData: portal access denied, returning empty`)
      return {
        boards: [],
        posts: { items: [], hasMore: false, total: 0 },
        statuses: [],
        tags: [],
        votedPostIds: [],
        principalId: null,
      }
    }

    // Resolve the policy actor from the current session before fanning out the
    // parallel queries. List helpers default to ANONYMOUS_ACTOR; we pass the
    // real one so signed-in users and segment members see audience-restricted
    // boards + their own pending posts.
    const auth = await getOptionalAuth()
    const actor = await policyActorFromAuth(auth)

    // Run ALL queries in parallel for maximum performance
    // Member lookup and votes run independently alongside posts/boards/statuses/tags
    const [memberResult, boardsRaw, postsResult, statuses, tags, allVotedPosts] = await Promise.all(
      [
        // Principal lookup (needed for principalId in response)
        data.userId
          ? db.query.principal.findFirst({
              where: eq(principalTable.userId, data.userId as UserId),
              columns: { id: true },
            })
          : null,
        listPublicBoardsWithStats(actor),
        // Posts WITHOUT embedded vote check (we get votes separately for parallelism)
        listPublicPostsWithVotesAndAvatars({
          actor,
          boardSlug: data.boardSlug,
          search: data.search,
          statusSlugs: data.statusSlugs,
          tagIds: data.tagIds as TagId[] | undefined,
          sort: data.sort,
          page: 1,
          limit: 20,
          minVotes: data.minVotes,
          dateFrom: data.dateFrom,
          responded: data.responded,
        }),
        listPublicStatuses(),
        listPublicTags(),
        // Get ALL voted post IDs for this user (runs in parallel, we'll filter to displayed posts)
        data.userId
          ? getVotedPostIdsByUserId(data.userId as UserId)
          : Promise.resolve(new Set<PostId>()),
      ]
    )
    const principalId = memberResult?.id ?? null

    // Per-board submit/vote capability for THIS viewer, composed with the
    // workspace anonymous switch. The UI uses these booleans to decide whether
    // to advertise the submit/vote CTAs instead of re-deriving from the
    // workspace flag and showing an action the per-board tier rejects (#191).
    // Keyed by board id: vote permission is per-board, so this one map also
    // covers infinite-scroll feed pages (every post belongs to one of these
    // boards). Computed in-memory from boardsRaw.access — no extra query.
    const { boardCapabilitiesForActor } = await import('@/lib/server/policy')
    const { getPortalConfig } = await import('@/lib/server/domains/settings/settings.service')
    const allowAnonymous = (await getPortalConfig()).features.allowAnonymous ?? false
    const boardPermissions: Record<string, { canSubmit: boolean; canVote: boolean }> = {}
    for (const b of boardsRaw) {
      boardPermissions[b.id] = boardCapabilitiesForActor(actor, b.access, allowAnonymous)
    }

    // Return ALL voted post IDs (not just page 1) so infinite scroll pages show correct vote state
    const votedPostIds = Array.from(allVotedPosts)

    const posts = {
      items: postsResult.items.map((post) => ({
        id: post.id,
        title: post.title,
        content: post.content,
        statusId: post.statusId,
        voteCount: post.voteCount,
        authorName: post.authorName,
        principalId: post.principalId,
        createdAt: post.createdAt.toISOString(),
        commentCount: post.commentCount,
        tags: post.tags,
        board: post.board,
      })),
      hasMore: postsResult.hasMore,
      total: -1,
    }

    return {
      boards: boardsRaw.map((b) => ({ ...b, settings: (b.settings ?? {}) as BoardSettings })),
      posts,
      statuses,
      tags,
      votedPostIds,
      principalId,
      boardPermissions,
    }
  })

export const fetchPublicBoards = createServerFn({ method: 'GET' }).handler(async () => {
  console.log(`[fn:portal] fetchPublicBoards`)
  try {
    // Outer gate: private portal + unauthorized caller → no boards.
    const access = await resolvePortalAccessForRequest()
    if (!access.granted) {
      console.log(`[fn:portal] fetchPublicBoards: portal access denied, returning empty`)
      return []
    }

    const auth = await getOptionalAuth()
    const actor = await policyActorFromAuth(auth)
    const boards = await listPublicBoardsWithStats(actor)
    return boards.map((b) => ({ ...b, settings: (b.settings ?? {}) as BoardSettings }))
  } catch (error) {
    console.error(`[fn:portal] fetchPublicBoards failed:`, error)
    throw error
  }
})

export const fetchPublicBoardBySlug = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ slug: z.string() }))
  .handler(async ({ data }) => {
    console.log(`[fn:portal] fetchPublicBoardBySlug: slug=${data.slug}`)
    try {
      // Outer gate: private portal + unauthorized caller → no board.
      const access = await resolvePortalAccessForRequest()
      if (!access.granted) {
        console.log(`[fn:portal] fetchPublicBoardBySlug: portal access denied, returning null`)
        return null
      }

      // Direct-load lookup must honour the request actor — otherwise an
      // authenticated/segment-member user navigating directly to the slug
      // is denied a board they can see in the portal list. Without the
      // actor, the helper defaults to ANONYMOUS_ACTOR and only public
      // boards round-trip.
      const auth = await getOptionalAuth()
      const actor = await policyActorFromAuth(auth)
      const board = await getPublicBoardBySlug(data.slug, actor)
      if (!board) return null
      return { ...board, settings: (board.settings ?? {}) as BoardSettings }
    } catch (error) {
      console.error(`[fn:portal] fetchPublicBoardBySlug failed:`, error)
      throw error
    }
  })

export const fetchPublicPostDetail = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ postId: z.string() }))
  .handler(async ({ data }) => {
    console.log(`[fn:portal] fetchPublicPostDetail: postId=${data.postId}`)

    // Outer gate: a private portal serves no post detail to a caller the
    // portal-access resolver denies. The per-board audience check inside
    // getPublicPostDetail stays as the inner layer for granted callers.
    const access = await resolvePortalAccessForRequest()
    if (!access.granted) {
      console.log(`[fn:portal] fetchPublicPostDetail: portal access denied, returning null`)
      return null
    }

    // The policy actor is the sole input getPublicPostDetail needs:
    // it drives the visibility check, the principalId-for-own-comments
    // lookup, and the include-private-comments flag (derived from
    // isTeamActor). Same resolution path as list reads.
    const auth = hasAuthCredentials() ? await getOptionalAuth() : null
    const actor = await policyActorFromAuth(auth)
    const result = await getPublicPostDetail(data.postId as PostId, actor)

    if (!result) return null

    // Helper to safely convert Date or string to ISO string
    // Raw SQL may return dates as strings depending on the driver
    const toISOString = (date: Date | string): string =>
      typeof date === 'string' ? date : date.toISOString()

    type CommentType = (typeof result.comments)[0]
    type SerializedComment = Omit<CommentType, 'createdAt' | 'replies'> & {
      createdAt: string
      replies: SerializedComment[]
    }
    function serializeComment(c: CommentType): SerializedComment {
      return {
        ...c,
        createdAt: toISOString(c.createdAt),
        replies: c.replies.map(serializeComment),
      }
    }

    // Fetch merge info for this post. Pass the same actor used to gate
    // the post detail above so the canonical's audience check runs from
    // the caller's perspective — without it, the canonical's title and
    // board slug could leak through the merge banner.
    const postId = data.postId as PostId
    const [mergeInfo, mergedPostsList] = await Promise.all([
      getPostMergeInfo(postId, actor).then((info) =>
        info ? { ...info, mergedAt: toISOString(info.mergedAt) } : null
      ),
      getMergedPosts(postId),
    ])

    return {
      ...result,
      contentJson: result.contentJson ?? {},
      createdAt: toISOString(result.createdAt),
      comments: result.comments.map(serializeComment),
      mergeInfo,
      mergedPostCount: mergedPostsList.length > 0 ? mergedPostsList.length : undefined,
    }
  })

export const fetchPublicPosts = createServerFn({ method: 'GET' })
  .inputValidator(fetchPublicPostsSchema)
  .handler(async ({ data }) => {
    console.log(`[fn:portal] fetchPublicPosts: boardSlug=${data.boardSlug}, sort=${data.sort}`)
    try {
      // Outer gate: private portal + unauthorized caller → no posts.
      const access = await resolvePortalAccessForRequest()
      if (!access.granted) {
        console.log(`[fn:portal] fetchPublicPosts: portal access denied, returning empty`)
        return { items: [], hasMore: false, total: 0 }
      }

      const auth = await getOptionalAuth()
      const actor = await policyActorFromAuth(auth)
      const result = await listPublicPosts({ ...data, page: 1, limit: 20, actor })
      return {
        ...result,
        items: result.items.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
      }
    } catch (error) {
      console.error(`[fn:portal] fetchPublicPosts failed:`, error)
      throw error
    }
  })

export const fetchPublicStatuses = createServerFn({ method: 'GET' }).handler(async () => {
  console.log(`[fn:portal] fetchPublicStatuses`)
  try {
    // Outer gate: a private portal must not expose its status taxonomy to a
    // denied caller.
    const access = await resolvePortalAccessForRequest()
    if (!access.granted) {
      console.log(`[fn:portal] fetchPublicStatuses: portal access denied, returning empty`)
      return []
    }
    return await listPublicStatuses()
  } catch (error) {
    console.error(`[fn:portal] fetchPublicStatuses failed:`, error)
    throw error
  }
})

export const fetchPublicTags = createServerFn({ method: 'GET' }).handler(async () => {
  console.log(`[fn:portal] fetchPublicTags`)
  try {
    // Outer gate: a private portal must not expose its tag taxonomy to a
    // denied caller.
    const access = await resolvePortalAccessForRequest()
    if (!access.granted) {
      console.log(`[fn:portal] fetchPublicTags: portal access denied, returning empty`)
      return []
    }
    return await listPublicTags()
  } catch (error) {
    console.error(`[fn:portal] fetchPublicTags failed:`, error)
    throw error
  }
})

export const fetchUserAvatar = createServerFn({ method: 'GET' })
  .inputValidator(
    z.object({ userId: z.string(), fallbackImageUrl: z.string().nullable().optional() })
  )
  .handler(async ({ data }) => {
    console.log(`[fn:portal] fetchUserAvatar: userId=${data.userId}`)
    try {
      const user = await db.query.user.findFirst({
        where: eq(userTable.id, data.userId as UserId),
        columns: { imageKey: true, image: true },
      })

      if (!user) return { avatarUrl: data.fallbackImageUrl ?? null, hasCustomAvatar: false }

      if (user.imageKey) {
        const avatarUrl = getPublicUrlOrNull(user.imageKey)
        if (avatarUrl) {
          return { avatarUrl, hasCustomAvatar: true }
        }
      }

      return { avatarUrl: user.image ?? data.fallbackImageUrl ?? null, hasCustomAvatar: false }
    } catch (error) {
      console.error(`[fn:portal] fetchUserAvatar failed:`, error)
      throw error
    }
  })

export const fetchAvatars = createServerFn({ method: 'GET' })
  .inputValidator(z.array(z.string()))
  .handler(async ({ data }) => {
    console.log(`[fn:portal] fetchAvatars: count=${data.length}`)
    try {
      const principalIds = (data as PrincipalId[]).filter((id): id is PrincipalId => id !== null)
      if (principalIds.length === 0) return {}

      const principals = await db
        .select({
          id: principalTable.id,
          avatarKey: principalTable.avatarKey,
          avatarUrl: principalTable.avatarUrl,
        })
        .from(principalTable)
        .where(inArray(principalTable.id, principalIds))

      const avatarMap = new Map<PrincipalId, string | null>()
      for (const p of principals) {
        const s3Url = p.avatarKey ? getPublicUrlOrNull(p.avatarKey) : null
        avatarMap.set(p.id, s3Url ?? p.avatarUrl)
      }
      for (const id of principalIds) {
        if (!avatarMap.has(id)) avatarMap.set(id, null)
      }

      return Object.fromEntries(avatarMap)
    } catch (error) {
      console.error(`[fn:portal] fetchAvatars failed:`, error)
      throw error
    }
  })

export const fetchSubscriptionStatus = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ principalId: z.string(), postId: z.string() }))
  .handler(async ({ data }) => {
    console.log(
      `[fn:portal] fetchSubscriptionStatus: principalId=${data.principalId}, postId=${data.postId}`
    )
    try {
      // The route used to accept a client-supplied principalId with no
      // auth check at all — a textbook IDOR. Lock the lookup to the
      // caller's own principal unless they're team. Team-role actors
      // can read any principal's subscription (admin support flow).
      const auth = await requireAuth({ roles: ['admin', 'member', 'user'] })
      const requestedPrincipalId = data.principalId as PrincipalId
      const isTeam = auth.principal.role === 'admin' || auth.principal.role === 'member'
      if (!isTeam && requestedPrincipalId !== auth.principal.id) {
        // 404-shape so denied callers can't probe other users'
        // subscription state by varying principalId.
        throw new NotFoundError(
          'SUBSCRIPTION_NOT_FOUND',
          `Subscription not found for principal ${requestedPrincipalId}`
        )
      }
      // Audience gate: even the caller themselves shouldn't be able to
      // read a subscription tied to a post they can't view (the
      // subscribe path is also gated below, but a stale row from before
      // an audience change could otherwise leak the post's existence).
      const { assertPostViewable } = await import('@/lib/server/domains/posts/post.access')
      const actor = await policyActorFromAuth(auth)
      await assertPostViewable(data.postId as PostId, actor)
      return await getSubscriptionStatus(requestedPrincipalId, data.postId as PostId)
    } catch (error) {
      console.error(`[fn:portal] fetchSubscriptionStatus failed:`, error)
      throw error
    }
  })

export const fetchPublicRoadmaps = createServerFn({ method: 'GET' }).handler(async () => {
  console.log(`[fn:portal] fetchPublicRoadmaps`)
  try {
    // Outer gate: private portal + unauthorized caller → no roadmaps.
    const access = await resolvePortalAccessForRequest()
    if (!access.granted) {
      console.log(`[fn:portal] fetchPublicRoadmaps: portal access denied, returning empty`)
      return []
    }

    const roadmaps = await listPublicRoadmaps()
    return roadmaps.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      isPublic: r.isPublic,
      position: r.position,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }))
  } catch (error) {
    console.error(`[fn:portal] fetchPublicRoadmaps failed:`, error)
    throw error
  }
})

export const fetchPublicRoadmapPosts = createServerFn({ method: 'GET' })
  .inputValidator(
    z.object({
      roadmapId: z.string(),
      statusId: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
      search: z.string().optional(),
      boardIds: z.array(z.string()).optional(),
      tagIds: z.array(z.string()).optional(),
      segmentIds: z.array(z.string()).optional(),
      sort: z.enum(['votes', 'newest', 'oldest']).optional(),
    })
  )
  .handler(async ({ data }) => {
    console.log(
      `[fn:portal] fetchPublicRoadmapPosts: roadmapId=${data.roadmapId}, limit=${data.limit}, offset=${data.offset}`
    )
    try {
      // Outer gate: private portal + unauthorized caller → no roadmap posts.
      const access = await resolvePortalAccessForRequest()
      if (!access.granted) {
        console.log(`[fn:portal] fetchPublicRoadmapPosts: portal access denied, returning empty`)
        return { items: [], hasMore: false, total: 0 }
      }

      // Resolve auth once — used for both the segment-filter gate and
      // the per-board audience filter on getPublicRoadmapPosts.
      const auth = hasAuthCredentials() ? await getOptionalAuth() : null

      // Segment filtering requires admin/member role
      let segmentIds: SegmentId[] | undefined
      if (data.segmentIds?.length && auth && isTeamMember(auth.principal.role)) {
        segmentIds = data.segmentIds as SegmentId[]
        // Non-team callers silently ignore segmentIds
      }

      const actor = await policyActorFromAuth(auth)

      const result = await getPublicRoadmapPosts(
        data.roadmapId as RoadmapId,
        {
          statusId: data.statusId as StatusId | undefined,
          limit: data.limit ?? 20,
          offset: data.offset ?? 0,
          search: data.search,
          boardIds: data.boardIds as BoardId[] | undefined,
          tagIds: data.tagIds as TagId[] | undefined,
          segmentIds,
          sort: data.sort,
        },
        actor
      )

      return {
        ...result,
        items: result.items.map((item) => ({
          id: String(item.id),
          title: item.title,
          voteCount: item.voteCount,
          statusId: item.statusId ? String(item.statusId) : null,
          board: { id: String(item.board.id), name: item.board.name, slug: item.board.slug },
          roadmapEntry: {
            postId: String(item.roadmapEntry.postId),
            roadmapId: String(item.roadmapEntry.roadmapId),
            position: item.roadmapEntry.position,
          },
        })),
      }
    } catch (error) {
      console.error(`[fn:portal] fetchPublicRoadmapPosts failed:`, error)
      throw error
    }
  })

const getCommentsSectionDataSchema = z.object({ postId: z.string() })

export const getCommentsSectionDataFn = createServerFn({ method: 'GET' })
  .inputValidator(getCommentsSectionDataSchema)
  .handler(async ({ data }) => {
    console.log(`[fn:portal] getCommentsSectionDataFn: postId=${data.postId}`)
    const denied = { isMember: false, isTeamMember: false, canComment: false, user: undefined }
    try {
      const postId = data.postId as PostId

      // Portal-visibility gate: a caller who can't see the portal must not
      // learn whether commenting is open. Mirrors getVoteSidebarDataFn.
      const access = await resolvePortalAccessForRequest()
      if (!access.granted) return denied

      const ctx = await getOptionalAuth()
      const actor = await policyActorFromAuth(ctx)

      // Per-post audience gate: a portal-granted caller can still be probing a
      // post on a team-only / segment-restricted board. NotFound => denial.
      try {
        const { assertPostViewable } = await import('@/lib/server/domains/posts/post.access')
        await assertPostViewable(postId, actor)
      } catch (err) {
        if (err instanceof Error && err.name === 'NotFoundError') return denied
        throw err
      }

      // Per-board comment tier gate: a board can be public-to-view but
      // authenticated-only-to-comment (the modern "Public" preset). Resolve
      // board.access alongside the post and run canCreateComment so the UI
      // renders the right CTA instead of letting the click learn the truth on
      // submit. The workspace anonymous switch is composed below as a ceiling.
      const { db, eq, and, isNull, posts, boards } = await import('@/lib/server/db')
      const { canCreateComment } = await import('@/lib/server/policy')
      const boardRow = await db
        .select({ access: boards.access })
        .from(posts)
        .innerJoin(boards, eq(posts.boardId, boards.id))
        .where(and(eq(posts.id, postId), isNull(posts.deletedAt), isNull(boards.deletedAt)))
        .limit(1)
      if (boardRow.length === 0) return denied

      // assertPostViewable already proved view-allowed for this actor; pass
      // moderationState='published' so the inner view check is a no-op and the
      // decision reflects the comment tier specifically. Comments-locked is
      // handled by the component (lockedMessage), so it is not gated here.
      const decision = canCreateComment(
        actor,
        { moderationState: 'published', principalId: null, isCommentsLocked: false },
        { access: boardRow[0].access },
        undefined
      )

      // Compose the workspace anonymous master switch (collapsed from the
      // legacy anonymousCommenting flag in migration 0084) for anonymous /
      // no-session viewers. The per-board tier is the inner ceiling.
      let canComment = decision.allowed
      if (actor.principalType !== 'user') {
        const { getPortalConfig } = await import('@/lib/server/domains/settings/settings.service')
        const config = await getPortalConfig()
        canComment = canComment && (config.features.allowAnonymous ?? false)
      }

      const isMember = !!(ctx?.user && ctx?.principal)
      const isTeamMember =
        isMember && (ctx.principal.role === 'admin' || ctx.principal.role === 'member')

      return {
        isMember,
        isTeamMember,
        canComment,
        user: isMember
          ? { name: ctx.user.name, email: ctx.user.email, principalId: ctx.principal.id }
          : undefined,
      }
    } catch (error) {
      console.error(`[fn:portal] getCommentsSectionDataFn failed:`, error)
      throw error
    }
  })
