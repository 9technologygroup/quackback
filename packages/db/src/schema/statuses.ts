import { pgTable, text, timestamp, boolean, integer, index } from 'drizzle-orm/pg-core'
import { typeIdWithDefault } from '@quackback/ids/drizzle'
import { STATUS_CATEGORIES, type StatusCategory } from '../types'

// Re-export for convenience (canonical source is ../types.ts)
export { STATUS_CATEGORIES, type StatusCategory }

export const postStatuses = pgTable(
  'post_statuses',
  {
    id: typeIdWithDefault('status')('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    color: text('color').notNull().default('#6b7280'),
    category: text('category', { enum: STATUS_CATEGORIES }).notNull().default('active'),
    position: integer('position').notNull().default(0),
    showOnRoadmap: boolean('show_on_roadmap').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // Soft delete support
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    // Note: post_statuses_slug_unique constraint already provides uniqueness; no separate index needed
    index('post_statuses_position_idx').on(table.category, table.position),
    index('post_statuses_deleted_at_idx').on(table.deletedAt),
  ]
)

// Relations are defined in posts.ts to avoid circular dependency

// Default statuses to seed for new workspaces
export const DEFAULT_STATUSES: Array<{
  name: string
  slug: string
  color: string
  category: StatusCategory
  position: number
  showOnRoadmap: boolean
  isDefault: boolean
}> = [
  // Active statuses
  {
    name: 'Open',
    slug: 'open',
    color: '#3b82f6',
    category: 'active',
    position: 0,
    showOnRoadmap: false,
    isDefault: true,
  },
  {
    name: 'Under Review',
    slug: 'under_review',
    color: '#eab308',
    category: 'active',
    position: 1,
    showOnRoadmap: false,
    isDefault: false,
  },
  {
    // Reviewed and agreed, but not yet scheduled. The first status that makes
    // a promise publicly, which is why it's also the first shown on the roadmap.
    name: 'Accepted',
    slug: 'accepted',
    color: '#14b8a6',
    category: 'active',
    position: 2,
    showOnRoadmap: true,
    isDefault: false,
  },
  {
    name: 'Planned',
    slug: 'planned',
    color: '#a855f7',
    category: 'active',
    position: 3,
    showOnRoadmap: true,
    isDefault: false,
  },
  {
    name: 'In Progress',
    slug: 'in_progress',
    color: '#f97316',
    category: 'active',
    position: 4,
    showOnRoadmap: true,
    isDefault: false,
  },
  // Complete statuses
  {
    name: 'Complete',
    slug: 'complete',
    color: '#22c55e',
    category: 'complete',
    position: 0,
    showOnRoadmap: true,
    isDefault: false,
  },
  // Closed statuses
  {
    name: 'Closed',
    slug: 'closed',
    color: '#6b7280',
    category: 'closed',
    position: 0,
    showOnRoadmap: false,
    isDefault: false,
  },
  {
    // Reviewed and turned down. Kept distinct from Closed so "we said no, and
    // here's why" is separable from "this went away" when someone asks later.
    name: 'Declined',
    slug: 'declined',
    color: '#ef4444',
    category: 'closed',
    position: 1,
    showOnRoadmap: false,
    isDefault: false,
  },
  {
    // Not now, rather than not ever. Leaves the active queue so triage stays
    // honest, but stays searchable so it can be revived instead of re-filed.
    name: 'Deferred',
    slug: 'deferred',
    color: '#64748b',
    category: 'closed',
    position: 2,
    showOnRoadmap: false,
    isDefault: false,
  },
]
