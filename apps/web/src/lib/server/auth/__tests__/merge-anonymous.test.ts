import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PrincipalId, UserId } from '@quackback/ids'
import {
  operations,
  mockTransaction,
  mockUpdateSet,
  opsFor,
  resetDbMockState,
} from '@/lib/server/__tests__/principal-merge-db-mock'

// The orchestrators run through the REAL re-point registry and factory
// teardown; only the db module is mocked (shared harness), so these are
// behavior tests for both paths.
vi.mock('@/lib/server/db', async () =>
  (await import('@/lib/server/__tests__/principal-merge-db-mock')).mockDbModule()
)

vi.mock('@/lib/server/redis', () => ({
  cacheDel: vi.fn(),
  CACHE_KEYS: { PRINCIPAL_BY_USER: (id: string) => `principal:user:${id}` },
}))

import { mergeAnonymousToIdentified, absorbSignupIntoAnonymous } from '../merge-anonymous'

const ANON_PRINCIPAL_ID = 'principal_anon' as PrincipalId
const TARGET_PRINCIPAL_ID = 'principal_target' as PrincipalId
const ANON_USER_ID = 'user_anon' as UserId

beforeEach(() => {
  resetDbMockState()
})

describe('mergeAnonymousToIdentified', () => {
  const defaultParams = {
    anonPrincipalId: ANON_PRINCIPAL_ID,
    targetPrincipalId: TARGET_PRINCIPAL_ID,
    anonUserId: ANON_USER_ID,
    anonDisplayName: 'Curious Penguin',
    targetDisplayName: 'Jane Doe',
  }

  it('runs the merge inside a database transaction', async () => {
    await mergeAnonymousToIdentified(defaultParams)
    expect(mockTransaction).toHaveBeenCalledTimes(1)
  })

  it('re-points every registered activity table to the target principal', async () => {
    await mergeAnonymousToIdentified(defaultParams)

    for (const table of [
      'post_votes',
      'post_comment_reactions',
      'post_comments',
      'posts',
      'post_edit_history',
      'post_comment_edit_history',
      'post_activity',
      'conversations',
      'conversation_messages',
      'post_subscriptions',
      'in_app_notifications',
      'page_views',
      'visitor_devices',
      'user_segments',
      'kb_article_feedback',
    ]) {
      expect(operations, `expected an update for ${table}`).toContain(`update:${table}`)
    }
  })

  it('deletes colliding anon rows before re-pointing unique-constrained tables', async () => {
    await mergeAnonymousToIdentified(defaultParams)

    for (const table of [
      'post_votes',
      'post_comment_reactions',
      'post_subscriptions',
      'kb_article_feedback',
      'user_segments',
    ]) {
      const ops = opsFor(table)
      expect(
        ops.indexOf(`delete:${table}`),
        `${table} conflict delete must precede update`
      ).toBeLessThan(ops.indexOf(`update:${table}`))
    }
  })

  it('re-points conversations + messages before deleting the principal', async () => {
    // conversations.visitor_principal_id and conversation_messages.principal_id are
    // ON DELETE RESTRICT, so the anon-principal delete would throw if the conversation
    // rows were not transferred first. This pins that ordering.
    await mergeAnonymousToIdentified(defaultParams)

    const principalIdx = operations.indexOf('delete:principal')
    expect(operations.indexOf('update:conversations')).toBeLessThan(principalIdx)
    expect(operations.indexOf('update:conversation_messages')).toBeLessThan(principalIdx)
  })

  it('deletes self-notifications and rewrites titles for transferred comments', async () => {
    await mergeAnonymousToIdentified(defaultParams)

    // self-notification delete, title fixup, then the re-point (the first two
    // match the anon user's comments via a correlated EXISTS)
    expect(opsFor('in_app_notifications')).toEqual([
      'delete:in_app_notifications',
      'update:in_app_notifications',
      'update:in_app_notifications',
    ])
  })

  it('fills an empty target contact_email via one conditional UPDATE', async () => {
    await mergeAnonymousToIdentified(defaultParams)

    // The SET pulls the source email with a correlated subquery; fill-if-empty
    // is enforced by the contact_email IS NULL guard on the target in the
    // WHERE, so a target that already has a value is never overwritten.
    expect(mockUpdateSet).toHaveBeenCalledWith({
      contactEmail: expect.objectContaining({ _type: 'sql' }),
    })
    const { isNull } = await import('@/lib/server/db')
    expect(isNull).toHaveBeenCalledWith('principal.contactEmail')
  })

  it('cleans up anonymous principal, sessions, and user', async () => {
    await mergeAnonymousToIdentified(defaultParams)

    expect(operations).toContain('delete:principal')
    expect(operations).toContain('delete:session')
    expect(operations).toContain('delete:user')
  })

  it('deletes principal before sessions and user', async () => {
    await mergeAnonymousToIdentified(defaultParams)

    const principalIdx = operations.indexOf('delete:principal')
    const sessionIdx = operations.indexOf('delete:session')
    const userIdx = operations.indexOf('delete:user')

    // Principal must be deleted first (it references userId)
    expect(principalIdx).toBeLessThan(sessionIdx)
    expect(principalIdx).toBeLessThan(userIdx)
  })

  it('handles anonymous user with no activity gracefully', async () => {
    await mergeAnonymousToIdentified(defaultParams)

    expect(operations).toContain('delete:principal')
    expect(operations).toContain('delete:session')
    expect(operations).toContain('delete:user')
  })
})

describe('absorbSignupIntoAnonymous', () => {
  const NEW_USER_ID = 'user_new' as UserId
  const NEW_PRINCIPAL_ID = 'principal_new' as PrincipalId

  const defaultParams = {
    anonUserId: ANON_USER_ID,
    anonPrincipalId: ANON_PRINCIPAL_ID,
    newUserId: NEW_USER_ID,
    newUserPrincipalId: NEW_PRINCIPAL_ID,
    name: 'Jane Doe',
    email: 'jane@example.com',
    image: null,
    displayName: 'Jane Doe',
  }

  it('runs inside a single transaction', async () => {
    await absorbSignupIntoAnonymous(defaultParams)
    expect(mockTransaction).toHaveBeenCalledTimes(1)
  })

  it('re-parents account and session rows before deleting the new user', async () => {
    await absorbSignupIntoAnonymous(defaultParams)

    const deleteUserIdx = operations.indexOf('delete:user')
    expect(operations.indexOf('update:account')).toBeLessThan(deleteUserIdx)
    expect(operations.indexOf('update:session')).toBeLessThan(deleteUserIdx)
  })

  it('runs the shared re-point registry from the new principal to the anon principal', async () => {
    await absorbSignupIntoAnonymous(defaultParams)

    // Same registry as the sign-in merge: any activity the throwaway signup
    // principal acquired follows the surviving anonymous principal.
    expect(operations).toContain('update:post_votes')
    expect(operations).toContain('update:conversations')
    expect(operations).toContain('update:user_segments')
  })

  it('skips the registry when the new user never got a principal', async () => {
    await absorbSignupIntoAnonymous({ ...defaultParams, newUserPrincipalId: null })

    expect(operations).not.toContain('update:post_votes')
    expect(operations).not.toContain('delete:principal')
    expect(operations).toContain('delete:user')
  })

  it('deletes the new identity before updating the anon user (frees the email)', async () => {
    await absorbSignupIntoAnonymous(defaultParams)

    expect(operations).toContain('delete:principal')
    expect(operations.indexOf('delete:user')).toBeLessThan(operations.indexOf('update:user'))
  })

  it('stamps the real identity onto the surviving user and upgrades the principal', async () => {
    const { cacheKeysToBust } = await absorbSignupIntoAnonymous(defaultParams)

    expect(mockUpdateSet).toHaveBeenCalledWith({
      name: 'Jane Doe',
      email: 'jane@example.com',
      emailVerified: true,
      isAnonymous: false,
      image: null,
    })
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user', displayName: 'Jane Doe' })
    )
    // The type flip invalidates the principal cache; keys are returned for the
    // caller to bust after commit.
    expect(cacheKeysToBust).toEqual([`principal:user:${ANON_USER_ID}`])
  })
})
