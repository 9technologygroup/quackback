/**
 * Shared typed mock fixtures for upload handler tests.
 *
 * Each fixture satisfies the full type expected by the corresponding mock,
 * derived from the actual function return types via ReturnType.
 */
import type { auth } from '@/lib/server/auth'
import type { db } from '@/lib/server/db'

// Derive types from the actual functions so tests stay in sync
type SessionResult = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>
type PrincipalRecord = NonNullable<Awaited<ReturnType<typeof db.query.principal.findFirst>>>

/** Create a mock Better Auth session result */
export function mockSession(
  overrides: Partial<{ user: Partial<SessionResult['user']> }> = {}
): SessionResult {
  return {
    session: {
      id: 'test-session-id',
      token: 'test-token',
      userId: 'user_test1',
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      ipAddress: null,
      userAgent: null,
    },
    user: {
      id: 'user_test1',
      email: 'user@example.com',
      name: 'User',
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides.user,
    },
  } as SessionResult
}

/** Create a mock principal record */
export function mockPrincipal(
  overrides: Partial<Pick<PrincipalRecord, 'type' | 'role'>> = {}
): PrincipalRecord {
  return {
    id: 'principal_test1',
    userId: 'user_test1',
    role: 'user',
    type: 'user',
    displayName: null,
    avatarUrl: null,
    avatarKey: null,
    serviceMetadata: null,
    contactEmail: null,
    chatAvailability: 'online',
    createdAt: new Date(),
    lastSsoSignInAt: null,
    ...overrides,
  } as PrincipalRecord
}
