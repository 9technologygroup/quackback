import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { withApiKeyAuth } from '@/lib/server/domains/api/auth'
import {
  successResponse,
  badRequestResponse,
  notFoundResponse,
  handleDomainError,
} from '@/lib/server/domains/api/responses'
import { db, segments, eq, and, isNull } from '@/lib/server/db'
import { addMember, removeMember } from '@/lib/server/domains/segments/segment-membership.service'
import type { PrincipalId } from '@quackback/ids'

const MutateBody = z.object({
  principalIds: z.array(z.string()).min(1).max(1000),
})

export const Route = createFileRoute('/api/v1/segments/$slug/members')({
  server: {
    handlers: {
      /**
       * POST /api/v1/segments/:slug/members
       * Add the given principalIds to the segment identified by :slug.
       *
       * Resolves the segment by `slug` (unique on non-deleted rows). Adding
       * with source='api' — the source-priority guard inside addMember
       * means we never demote a manual admin assignment.
       */
      POST: async ({ request, params }) => {
        try {
          const auth = await withApiKeyAuth(request, { role: 'team' })
          const body = MutateBody.parse(await request.json())

          const segment = await db.query.segments.findFirst({
            where: and(eq(segments.slug, params.slug), isNull(segments.deletedAt)),
            columns: { id: true },
          })
          if (!segment) return notFoundResponse('Segment')

          for (const principalId of body.principalIds) {
            await addMember({
              principalId: principalId as PrincipalId,
              segmentId: segment.id,
              source: 'api',
              actor: {
                userId: null,
                email: null,
                role: auth.role,
              },
              request,
            })
          }
          return successResponse({ added: body.principalIds.length })
        } catch (error) {
          if (error instanceof z.ZodError) return badRequestResponse(error.message)
          return handleDomainError(error)
        }
      },

      /**
       * DELETE /api/v1/segments/:slug/members
       * Remove the given principalIds from the segment.
       */
      DELETE: async ({ request, params }) => {
        try {
          const auth = await withApiKeyAuth(request, { role: 'team' })
          const body = MutateBody.parse(await request.json())

          const segment = await db.query.segments.findFirst({
            where: and(eq(segments.slug, params.slug), isNull(segments.deletedAt)),
            columns: { id: true },
          })
          if (!segment) return notFoundResponse('Segment')

          for (const principalId of body.principalIds) {
            await removeMember({
              principalId: principalId as PrincipalId,
              segmentId: segment.id,
              actor: {
                userId: null,
                email: null,
                role: auth.role,
              },
              request,
            })
          }
          return successResponse({ removed: body.principalIds.length })
        } catch (error) {
          if (error instanceof z.ZodError) return badRequestResponse(error.message)
          return handleDomainError(error)
        }
      },
    },
  },
})
