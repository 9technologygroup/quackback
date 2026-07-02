/**
 * Roadmap tools: add/remove a post on a roadmap.
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  addPostToRoadmap,
  removePostFromRoadmap,
} from '@/lib/server/domains/roadmaps/roadmap.service'
import type { PostId, RoadmapId } from '@quackback/ids'
import type { McpAuthContext } from '../types'
import { registerTool, jsonResult, WRITE } from './helpers'

// ============================================================================
// Schemas
// ============================================================================

const manageRoadmapPostSchema = {
  action: z.enum(['add', 'remove']).describe('Whether to add or remove the post from the roadmap'),
  roadmapId: z.string().describe('Roadmap TypeID'),
  postId: z.string().describe('Post TypeID'),
}

// ============================================================================
// Type aliases — manually defined to avoid deep Zod type recursion.
// WARNING: These must stay in sync with the Zod schemas above.
// If you add/remove/rename a field in a schema, update the matching type here.
// ============================================================================

type ManageRoadmapPostArgs = {
  action: 'add' | 'remove'
  roadmapId: string
  postId: string
}

// ============================================================================
// Tool registration
// ============================================================================

export function registerRoadmapTools(server: McpServer, auth: McpAuthContext) {
  registerTool<ManageRoadmapPostArgs>(server, auth, {
    name: 'manage_roadmap_post',
    description: `Add or remove a post from a roadmap.

Examples:
- Add: manage_roadmap_post({ action: "add", roadmapId: "roadmap_01abc...", postId: "post_01xyz..." })
- Remove: manage_roadmap_post({ action: "remove", roadmapId: "roadmap_01abc...", postId: "post_01xyz..." })`,
    schema: manageRoadmapPostSchema,
    annotations: WRITE,
    scope: 'write:feedback',
    teamOnly: true,
    handler: async (args) => {
      if (args.action === 'add') {
        await addPostToRoadmap(
          {
            postId: args.postId as PostId,
            roadmapId: args.roadmapId as RoadmapId,
          },
          auth.principalId
        )
      } else {
        await removePostFromRoadmap(
          args.postId as PostId,
          args.roadmapId as RoadmapId,
          auth.principalId
        )
      }

      return jsonResult({
        action: args.action,
        postId: args.postId,
        roadmapId: args.roadmapId,
      })
    },
  })
}
