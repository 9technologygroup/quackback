import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  apiKeysFindFirst: vi.fn(),
  apiKeysInsertReturning: vi.fn(),
  principalInsertReturning: vi.fn(),
  principalUpdateExecute: vi.fn(),
}))

vi.mock('@/lib/server/db', async () => {
  const drizzle = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm')
  return {
    db: {
      query: {
        apiKeys: { findFirst: (...a: unknown[]) => hoisted.apiKeysFindFirst(...a) },
      },
      insert: (table: { __name: string }) => ({
        values: () => {
          // principal insert has no onConflictDoNothing in the production path
          if (table.__name === 'principal') {
            return { returning: () => hoisted.principalInsertReturning() }
          }
          // apiKeys insert uses onConflictDoNothing for the seed-Job race
          return {
            onConflictDoNothing: () => ({
              returning: () => hoisted.apiKeysInsertReturning(),
            }),
          }
        },
      }),
      update: () => ({
        set: () => ({
          where: () => hoisted.principalUpdateExecute(),
        }),
      }),
    },
    apiKeys: { __name: 'api_keys', keyHash: 'kh' },
    principal: { __name: 'principal', id: 'id' },
    eq: drizzle.eq,
  }
})

import { upsertInternalApiKey } from '../internal-api-key-upsert'

const VALID_KEY = 'qb_' + 'a'.repeat(48)

describe('upsertInternalApiKey', () => {
  let originalKey: string | undefined
  beforeEach(() => {
    vi.clearAllMocks()
    originalKey = process.env.INTERNAL_API_KEY
    delete process.env.INTERNAL_API_KEY
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.INTERNAL_API_KEY
    else process.env.INTERNAL_API_KEY = originalKey
  })

  it('is a no-op when INTERNAL_API_KEY env var is unset (self-host parity)', async () => {
    await upsertInternalApiKey()
    expect(hoisted.apiKeysFindFirst).not.toHaveBeenCalled()
    expect(hoisted.apiKeysInsertReturning).not.toHaveBeenCalled()
  })

  it('is a no-op when INTERNAL_API_KEY env var has the wrong format', async () => {
    process.env.INTERNAL_API_KEY = 'not-a-real-key'
    await upsertInternalApiKey()
    expect(hoisted.apiKeysFindFirst).not.toHaveBeenCalled()
  })

  it('is a no-op when an api_keys row already exists for the hash (idempotent)', async () => {
    process.env.INTERNAL_API_KEY = VALID_KEY
    hoisted.apiKeysFindFirst.mockResolvedValue({ id: 'existing', keyHash: 'h' })
    await upsertInternalApiKey()
    expect(hoisted.apiKeysFindFirst).toHaveBeenCalledOnce()
    expect(hoisted.principalInsertReturning).not.toHaveBeenCalled()
    expect(hoisted.apiKeysInsertReturning).not.toHaveBeenCalled()
  })

  it('creates a service principal, inserts api_keys, then backfills principal serviceMetadata.apiKeyId', async () => {
    process.env.INTERNAL_API_KEY = VALID_KEY
    hoisted.apiKeysFindFirst.mockResolvedValue(undefined)
    hoisted.principalInsertReturning.mockResolvedValue([{ id: 'prn_new' }])
    hoisted.apiKeysInsertReturning.mockResolvedValue([{ id: 'apk_new' }])
    await upsertInternalApiKey()
    expect(hoisted.principalInsertReturning).toHaveBeenCalledOnce()
    expect(hoisted.apiKeysInsertReturning).toHaveBeenCalledOnce()
    // Backfill of serviceMetadata.apiKeyId happens only when api_keys insert
    // succeeded (i.e. we won the race with the seed Job).
    expect(hoisted.principalUpdateExecute).toHaveBeenCalledOnce()
  })

  it('tolerates ON CONFLICT DO NOTHING returning empty (race with seed Job)', async () => {
    process.env.INTERNAL_API_KEY = VALID_KEY
    hoisted.apiKeysFindFirst.mockResolvedValue(undefined)
    hoisted.principalInsertReturning.mockResolvedValue([{ id: 'prn_x' }])
    hoisted.apiKeysInsertReturning.mockResolvedValue([])
    await expect(upsertInternalApiKey()).resolves.toBeUndefined()
    // No backfill update when we lost the race — there's no apiKey id
    // to write, and the existing row already has its principal set.
    expect(hoisted.principalUpdateExecute).not.toHaveBeenCalled()
  })

  it('does not throw when DB throws (boot must not block on this)', async () => {
    process.env.INTERNAL_API_KEY = VALID_KEY
    hoisted.apiKeysFindFirst.mockRejectedValue(new Error('connection refused'))
    await expect(upsertInternalApiKey()).resolves.toBeUndefined()
  })
})
