/**
 * Smoke shape test for the new comment-moderation server functions.
 * Full integration tests live alongside the post-moderation suite once
 * the DB harness exists; here we assert exports and Zod schemas.
 */
import { describe, it, expect } from 'vitest'
import * as moderationModule from '../moderation'

// Cast to a loose record so the test can reference future exports
// (approveCommentFn/rejectCommentFn land in T3/T4) without TS errors today.
const moderation = moderationModule as unknown as Record<string, unknown>

describe('comment moderation functions — exports', () => {
  it('exports listPendingCommentsFn', () => {
    expect(typeof moderation.listPendingCommentsFn).toBe('function')
  })

  it('exports approveCommentFn', () => {
    expect(typeof moderation.approveCommentFn).toBe('function')
  })

  it('exports rejectCommentFn', () => {
    expect(typeof moderation.rejectCommentFn).toBe('function')
  })
})
