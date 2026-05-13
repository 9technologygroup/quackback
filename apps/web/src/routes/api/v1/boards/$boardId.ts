import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { withApiKeyAuth } from '@/lib/server/domains/api/auth'
import {
  successResponse,
  noContentResponse,
  badRequestResponse,
  handleDomainError,
} from '@/lib/server/domains/api/responses'
import { parseTypeId } from '@/lib/server/domains/api/validation'
import type { BoardId } from '@quackback/ids'

const audienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('public') }),
  z.object({ kind: z.literal('authenticated') }),
  z.object({ kind: z.literal('team') }),
  z.object({ kind: z.literal('segments'), segmentIds: z.array(z.string()).max(50) }),
])

// Input validation schema
const updateBoardSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  audience: audienceSchema.optional(),
})

export const Route = createFileRoute('/api/v1/boards/$boardId')({
  server: {
    handlers: {
      /**
       * GET /api/v1/boards/:boardId
       * Get a single board by ID
       */
      GET: async ({ request, params }) => {
        try {
          await withApiKeyAuth(request, { role: 'team' })

          const boardId = parseTypeId<BoardId>(params.boardId, 'board', 'board ID')

          const { getBoardById } = await import('@/lib/server/domains/boards/board.service')

          const board = await getBoardById(boardId)

          return successResponse({
            id: board.id,
            name: board.name,
            slug: board.slug,
            description: board.description,
            audience: board.audience,
            settings: board.settings,
            createdAt: board.createdAt.toISOString(),
            updatedAt: board.updatedAt.toISOString(),
          })
        } catch (error) {
          return handleDomainError(error)
        }
      },

      /**
       * PATCH /api/v1/boards/:boardId
       * Update a board
       */
      PATCH: async ({ request, params }) => {
        try {
          await withApiKeyAuth(request, { role: 'team' })

          const boardId = parseTypeId<BoardId>(params.boardId, 'board', 'board ID')

          const body = await request.json()
          const parsed = updateBoardSchema.safeParse(body)

          if (!parsed.success) {
            return badRequestResponse('Invalid request body', {
              errors: parsed.error.flatten().fieldErrors,
            })
          }

          const { updateBoard } = await import('@/lib/server/domains/boards/board.service')

          const board = await updateBoard(boardId, {
            name: parsed.data.name,
            slug: parsed.data.slug,
            description: parsed.data.description,
            audience: parsed.data.audience,
          })

          return successResponse({
            id: board.id,
            name: board.name,
            slug: board.slug,
            description: board.description,
            audience: board.audience,
            settings: board.settings,
            createdAt: board.createdAt.toISOString(),
            updatedAt: board.updatedAt.toISOString(),
          })
        } catch (error) {
          return handleDomainError(error)
        }
      },

      /**
       * DELETE /api/v1/boards/:boardId
       * Delete a board
       */
      DELETE: async ({ request, params }) => {
        try {
          await withApiKeyAuth(request, { role: 'team' })

          const boardId = parseTypeId<BoardId>(params.boardId, 'board', 'board ID')

          const { deleteBoard } = await import('@/lib/server/domains/boards/board.service')

          await deleteBoard(boardId)

          return noContentResponse()
        } catch (error) {
          return handleDomainError(error)
        }
      },
    },
  },
})
