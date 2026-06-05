import { db, pushDevices, eq } from '@/lib/server/db'
import type { PrincipalId } from '@quackback/ids'

export type PushPlatform = 'ios' | 'android'

/**
 * Register (or refresh) a push device for an agent. Idempotent on `token`:
 * re-registering the same token re-points it to the current principal and
 * bumps `lastSeenAt`, so a device handed to another agent can't keep an old
 * owner.
 */
export async function registerDevice(input: {
  principalId: PrincipalId
  token: string
  platform: PushPlatform
}): Promise<void> {
  await db
    .insert(pushDevices)
    .values({
      principalId: input.principalId,
      token: input.token,
      platform: input.platform,
    })
    .onConflictDoUpdate({
      target: pushDevices.token,
      set: {
        principalId: input.principalId,
        platform: input.platform,
        lastSeenAt: new Date(),
      },
    })
}

/** Remove a device by token (logout / token rotation). Safe if absent. */
export async function unregisterDevice(token: string): Promise<void> {
  await db.delete(pushDevices).where(eq(pushDevices.token, token))
}
