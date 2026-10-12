/**
 * Where the hash of a server-generated setup token lives until the install has
 * its first admin. Only the hash is kept, so a restart cannot print the token
 * again and a database reader cannot recover it.
 */
import { kvDel, kvGet, kvSetNx } from '@/lib/server/kv/pg-kv'
import { logger } from '@/lib/server/logger'

const KEY = 'setup:generated-token-hash'
const TTL_SECONDS = 60 * 60 * 24 * 365

const log = logger.child({ component: 'headless-setup' })

/** Stores the hash if there is none yet; true when this call stored it. */
export function storeGeneratedTokenHash(hash: string): Promise<boolean> {
  return kvSetNx(KEY, hash, TTL_SECONDS)
}

export function readGeneratedTokenHash(): Promise<string | null> {
  return kvGet<string>(KEY)
}

/**
 * Drops the generated token once the install has an admin, whichever path made
 * one. Best effort: a failure leaves a hash that opens nothing (the endpoint is
 * gone once an admin exists) and must not fail the setup that called it.
 */
export async function clearGeneratedToken(): Promise<void> {
  try {
    await kvDel(KEY)
  } catch (err) {
    log.warn({ err }, 'could not clear the generated setup token')
  }
}
