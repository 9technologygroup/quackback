/**
 * Server functions for board operations
 */

import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import type { BoardId } from '@quackback/ids'
import type { BoardSettings, BoardAudience, SetupState } from '@/lib/server/db'
import { requireAuth } from './auth-helpers'
import { getSettings } from './workspace'
import { db, settings, boards, eq, and, isNull } from '@/lib/server/db'
import {
  listBoards,
  getBoardById,
  createBoard,
  updateBoard,
  deleteBoard,
} from '@/lib/server/domains/boards/board.service'
import { invalidateSettingsCache } from '@/lib/server/domains/settings/settings.helpers'

// ============================================
// Schemas
// ============================================

const audienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('public') }),
  z.object({ kind: z.literal('authenticated') }),
  z.object({ kind: z.literal('team') }),
  z.object({ kind: z.literal('segments'), segmentIds: z.array(z.string()).max(50) }),
])

const createBoardSchema = z.object({
  name: z
    .string()
    .min(1, 'Board name is required')
    .max(100, 'Board name must be 100 characters or less'),
  description: z.string().max(500, 'Description must be 500 characters or less').optional(),
  // Back-compat with the existing admin create dialog which submits a binary
  // public/private toggle. Internally mapped to BoardAudience. Richer
  // audience choices (authenticated, segments[]) land via updateBoardAccessFn
  // after the board exists.
  isPublic: z.boolean().default(true),
})

const getBoardSchema = z.object({
  id: z.string(),
})

const boardSettingsSchema = z
  .object({
    roadmapStatusIds: z.array(z.string()).optional(),
  })
  .strict()

const updateBoardSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  // Visibility (audience + moderation) is NOT accepted here — those are
  // policy changes, admin-only via updateBoardAccessFn. If we accepted
  // audience on this team-level path, members could grant/revoke board
  // visibility despite the access-control split.
  isPublic: z.boolean().optional(),
  settings: boardSettingsSchema.optional(),
})

const deleteBoardSchema = z.object({
  id: z.string(),
})

const createBoardsBatchSchema = z.object({
  boards: z
    .array(
      z.object({
        name: z
          .string()
          .min(1, 'Board name is required')
          .max(100, 'Board name must be 100 characters or less'),
        description: z.string().max(500).optional(),
      })
    )
    .max(10, 'Maximum 10 boards can be created at once'),
})

// ============================================
// Type Exports
// ============================================

export type CreateBoardInput = z.infer<typeof createBoardSchema>
export type GetBoardInput = z.infer<typeof getBoardSchema>
export type UpdateBoardInput = z.infer<typeof updateBoardSchema>
export type DeleteBoardInput = z.infer<typeof deleteBoardSchema>
export type CreateBoardsBatchInput = z.infer<typeof createBoardsBatchSchema>

// ============================================
// Read Operations
// ============================================

function serializeBoard(b: Awaited<ReturnType<typeof listBoards>>[number]) {
  return {
    ...b,
    settings: (b.settings ?? {}) as BoardSettings,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  }
}

/**
 * List all boards for the authenticated user's workspace
 */
export const fetchBoardsFn = createServerFn({ method: 'GET' }).handler(async () => {
  console.log(`[fn:boards] fetchBoards`)
  await requireAuth({ roles: ['admin', 'member'] })

  const boards = await listBoards()
  console.log(`[fn:boards] fetchBoards: count=${boards.length}`)
  return boards.map(serializeBoard)
})

/**
 * Get a single board by ID
 */
export const fetchBoardFn = createServerFn({ method: 'GET' })
  .inputValidator(getBoardSchema)
  .handler(async ({ data }) => {
    console.log(`[fn:boards] fetchBoard: id=${data.id}`)
    await requireAuth({ roles: ['admin', 'member'] })

    const board = await getBoardById(data.id as BoardId)
    console.log(`[fn:boards] fetchBoard: found=${!!board}`)
    return serializeBoard(board)
  })

// ============================================
// Write Operations
// ============================================

/**
 * Create a new board
 */
export const createBoardFn = createServerFn({ method: 'POST' })
  .inputValidator(createBoardSchema)
  .handler(async ({ data }) => {
    console.log(`[fn:boards] createBoardFn: name=${data.name}`)
    await requireAuth({ roles: ['admin', 'member'] })

    // Map the binary toggle into an audience. Default to public when
    // omitted (the existing UI contract). For finer-grained audience
    // (authenticated, segments), the admin sets it via updateBoardAccessFn
    // after create — that path is admin-only and audited.
    const audience =
      data.isPublic === false ? { kind: 'team' as const } : { kind: 'public' as const }
    const board = await createBoard({
      name: data.name,
      description: data.description,
      audience,
    })
    console.log(`[fn:boards] createBoardFn: id=${board.id}`)
    return serializeBoard(board)
  })

/**
 * Update an existing board
 */
export const updateBoardFn = createServerFn({ method: 'POST' })
  .inputValidator(updateBoardSchema)
  .handler(async ({ data }) => {
    console.log(`[fn:boards] updateBoardFn: id=${data.id}`)
    await requireAuth({ roles: ['admin', 'member'] })

    // Update name/description/settings via the generic service.
    // audience is intentionally excluded from updateBoard (G2 fix) — the
    // service type enforces this.
    const board = await updateBoard(data.id as BoardId, {
      name: data.name,
      description: data.description,
      settings: data.settings as BoardSettings | undefined,
    })

    // The binary isPublic toggle maps to a two-value audience. Members can
    // use this path — it's the existing contract for the UI's simple
    // public/private toggle. Granular audience (authenticated, segments) is
    // admin-only via updateBoardAccessFn. We write audience directly here
    // because updateBoard no longer accepts it.
    if (data.isPublic !== undefined) {
      const audience: BoardAudience = data.isPublic ? { kind: 'public' } : { kind: 'team' }
      const [updatedWithAudience] = await db
        .update(boards)
        .set({ audience, updatedAt: new Date() })
        .where(and(eq(boards.id, data.id as BoardId), isNull(boards.deletedAt)))
        .returning()
      console.log(`[fn:boards] updateBoardFn: updated id=${board.id}`)
      return serializeBoard(updatedWithAudience)
    }

    console.log(`[fn:boards] updateBoardFn: updated id=${board.id}`)
    return serializeBoard(board)
  })

/**
 * Delete a board
 */
export const deleteBoardFn = createServerFn({ method: 'POST' })
  .inputValidator(deleteBoardSchema)
  .handler(async ({ data }) => {
    console.log(`[fn:boards] deleteBoardFn: id=${data.id}`)
    await requireAuth({ roles: ['admin', 'member'] })

    await deleteBoard(data.id as BoardId)
    console.log(`[fn:boards] deleteBoardFn: deleted id=${data.id}`)
    return { id: data.id }
  })

/**
 * Create multiple boards at once (for onboarding).
 * Allows empty array for skip functionality.
 * Updates setupState to mark boards step as complete.
 *
 * Tier-limit handling: if the request would exceed the tenant's
 * `maxBoards`, the call creates as many as fit (in input order) and
 * returns a `limited` flag — rather than throwing partway through and
 * leaving orphan boards behind. The wizard's boards step is treated
 * as "done" once the user has clicked Continue, regardless of how many
 * we ended up creating; otherwise a tenant on a 1-board plan who tries
 * to seed two would get stuck on /onboarding/boards forever.
 */
export const createBoardsBatchFn = createServerFn({ method: 'POST' })
  .inputValidator(createBoardsBatchSchema)
  .handler(async ({ data }) => {
    console.log(`[fn:boards] createBoardsBatchFn: count=${data.boards.length}`)
    await requireAuth({ roles: ['admin', 'member'] })

    // Pre-flight against the tier limit so we never call createBoard
    // (which throws on overage) past capacity. This means the loop is
    // exception-free under the maxBoards gate, and any boards the user
    // selected beyond the cap are silently dropped — the UI already
    // surfaces the limit warning above the list, so a partial create is
    // the expected outcome.
    const { getTierLimits } = await import('@/lib/server/domains/settings/tier-limits.service')
    const { listBoards } = await import('@/lib/server/domains/boards/board.service')
    const [limits, existingBoards] = await Promise.all([getTierLimits(), listBoards()])
    const remainingCapacity =
      limits.maxBoards == null ? Infinity : Math.max(0, limits.maxBoards - existingBoards.length)
    const toCreate = data.boards.slice(0, remainingCapacity)
    const limited = toCreate.length < data.boards.length

    const createdBoards = []
    for (const boardInput of toCreate) {
      const board = await createBoard({
        name: boardInput.name,
        description: boardInput.description,
        // Onboarding-batch boards default to public; admins can lock them
        // down later via updateBoardAccessFn.
      })
      createdBoards.push(serializeBoard(board))
    }

    if (data.boards.length === 0) {
      console.log(`[fn:boards] createBoardsBatchFn: skipped (no boards selected)`)
    } else if (limited) {
      console.log(
        `[fn:boards] createBoardsBatchFn: created ${createdBoards.length}/${data.boards.length} boards (tier limit)`
      )
    } else {
      console.log(`[fn:boards] createBoardsBatchFn: created ${createdBoards.length} boards`)
    }

    // Update setupState to mark boards step as complete (and onboarding as finished).
    // Always runs after the create loop — partial creates are still a successful
    // pass through the boards step from the wizard's perspective.
    const currentSettings = await getSettings()
    if (currentSettings?.setupState) {
      const setupState: SetupState = JSON.parse(currentSettings.setupState)

      if (!setupState.steps.boards) {
        const updatedState: SetupState = {
          ...setupState,
          steps: {
            ...setupState.steps,
            boards: true,
          },
          completedAt: new Date().toISOString(),
        }
        await db
          .update(settings)
          .set({ setupState: JSON.stringify(updatedState) })
          .where(eq(settings.id, currentSettings.id))
        await invalidateSettingsCache()
        console.log(`[fn:boards] createBoardsBatchFn: onboarding complete, setupState updated`)
      }
    }

    return { boards: createdBoards, limited }
  })

// ============================================
// v1 access controls — board audience
// ============================================

import { isAdmin } from '@/lib/shared/roles'
import { ForbiddenError, NotFoundError } from '@/lib/shared/errors'
import { recordAuditEvent, actorFromAuth } from '@/lib/server/audit/log'

// audienceSchema is defined at the top of this file (reused by create/update).

const updateBoardAccessSchema = z.object({
  boardId: z.string(),
  audience: audienceSchema.optional(),
})

/**
 * Update board.audience.
 *
 * isAdmin-gated — granting/revoking access is policy-level work. Members can
 * moderate posts (approve/reject) but not change who sees the board. Mirrors
 * the Canny/Featurebase/Linear split.
 */
export const updateBoardAccessFn = createServerFn({ method: 'POST' })
  .inputValidator(updateBoardAccessSchema.parse)
  .handler(async ({ data }) => {
    const auth = await requireAuth()
    if (!isAdmin(auth.principal.role)) {
      throw new ForbiddenError('FORBIDDEN', 'Admin only')
    }
    const before = await db.query.boards.findFirst({
      where: eq(boards.id, data.boardId as BoardId),
    })
    if (!before) throw new NotFoundError('BOARD_NOT_FOUND', `Board ${data.boardId} not found`)

    const updates: Record<string, unknown> = {}
    if (data.audience) updates.audience = data.audience
    if (Object.keys(updates).length === 0) return { ok: true }

    await db
      .update(boards)
      .set(updates)
      .where(eq(boards.id, data.boardId as BoardId))

    if (data.audience) {
      await recordAuditEvent({
        event: 'board.audience.changed',
        actor: actorFromAuth(auth),
        target: { type: 'board', id: data.boardId },
        before: { audience: before.audience },
        after: { audience: data.audience },
      })
    }

    return { ok: true }
  })
