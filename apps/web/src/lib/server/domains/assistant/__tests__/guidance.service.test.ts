import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import { assistantGuidanceRules } from '@/lib/server/db'
import {
  applyGuidanceBudget,
  assistantGuidanceRuleInputSchema,
} from '@/lib/shared/assistant/guidance'

vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

import {
  createGuidanceRule,
  deleteGuidanceRule,
  listEnabledGuidanceCandidates,
  listGuidanceRules,
  reorderGuidanceRules,
  updateGuidanceRule,
} from '../guidance.service'

const fixture = await createDbTestFixture({
  probe: async (db) => {
    await db.select({ name: assistantGuidanceRules.name }).from(assistantGuidanceRules).limit(0)
  },
})

describe('guidance shared contract', () => {
  it('normalizes text, preserves Unicode/newlines, and represents always-on as null', () => {
    const parsed = assistantGuidanceRuleInputSchema.parse({
      name: '  Ref\u0000unds  ',
      appliesWhen: ' \u0007 ',
      instruction: '  مرحبا\nExplain it.\u007f  ',
    })

    expect(parsed).toMatchObject({
      name: 'Refunds',
      appliesWhen: null,
      instruction: 'مرحبا\nExplain it.',
      roles: ['customer_support', 'suggested_reply'],
      channels: null,
      enabled: true,
      priority: 0,
    })
  })

  it('validates role and channel values', () => {
    expect(() =>
      assistantGuidanceRuleInputSchema.parse({
        name: 'Bad role',
        instruction: 'Do something.',
        roles: ['administrator'],
      })
    ).toThrow()
    expect(() =>
      assistantGuidanceRuleInputSchema.parse({
        name: 'Bad channel',
        instruction: 'Do something.',
        channels: ['sms'],
      })
    ).toThrow()
  })

  it('skips an oversized instruction and continues within the character budget', () => {
    const rules = [
      { id: 'oversized', instruction: 'x'.repeat(4_001) },
      { id: 'first', instruction: 'a'.repeat(3_000) },
      { id: 'does-not-fit', instruction: 'b'.repeat(1_001) },
      { id: 'later-shorter', instruction: 'c'.repeat(1_000) },
    ]

    expect(applyGuidanceBudget(rules).map((rule) => rule.id)).toEqual(['first', 'later-shorter'])
  })
})

describe.skipIf(!fixture.available)('guidance.service (real DB, rolled back)', () => {
  beforeEach(fixture.begin)
  afterEach(fixture.rollback)
  afterAll(fixture.close)

  it('creates normalized V2 guidance with defaults and lists by priority', async () => {
    const lower = await createGuidanceRule({
      name: '  Refund policy\u0000 ',
      appliesWhen: '   ',
      instruction: '  Always mention it.\u0007 ',
      priority: 2,
    })
    const higher = await createGuidanceRule({
      name: 'Security',
      appliesWhen: 'When a security issue is reported',
      instruction: 'Hand off to the security team.',
      priority: 1,
    })

    expect(lower).toMatchObject({
      name: 'Refund policy',
      appliesWhen: null,
      instruction: 'Always mention it.',
      roles: ['customer_support', 'suggested_reply'],
      channels: null,
      enabled: true,
      priority: 2,
    })
    expect((await listGuidanceRules()).map((rule) => rule.id)).toEqual([higher.id, lower.id])
  })

  it('prefilters enabled candidates by resolved role/channel', async () => {
    const everywhere = await createGuidanceRule({
      name: 'Everywhere',
      instruction: 'Always applies.',
      roles: ['customer_support'],
      priority: 1,
    })
    const widget = await createGuidanceRule({
      name: 'Widget',
      instruction: 'Widget only.',
      roles: ['customer_support'],
      channels: ['widget'],
      priority: 2,
    })
    await createGuidanceRule({
      name: 'Email',
      instruction: 'Email only.',
      roles: ['customer_support'],
      channels: ['email'],
    })
    await createGuidanceRule({
      name: 'Copilot role',
      instruction: 'Copilot only.',
      roles: ['copilot_qa'],
      channels: null,
    })
    await createGuidanceRule({
      name: 'Disabled',
      instruction: 'Disabled.',
      roles: ['customer_support'],
      enabled: false,
    })

    const candidates = await listEnabledGuidanceCandidates({
      role: 'customer_support',
      channel: 'widget',
    })
    expect(candidates.map((rule) => rule.id)).toEqual([everywhere.id, widget.id])
  })

  it('orders candidate ties by createdAt and caps the list at 25', async () => {
    await testDb.insert(assistantGuidanceRules).values(
      Array.from({ length: 27 }, (_, index) => ({
        name: `Rule ${index}`,
        instruction: `Instruction ${index}`,
        roles: ['customer_support'],
        priority: 0,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      }))
    )

    const candidates = await listEnabledGuidanceCandidates({
      role: 'customer_support',
      channel: 'email',
    })
    expect(candidates).toHaveLength(25)
    expect(candidates.map((rule) => rule.name)).toEqual(
      Array.from({ length: 25 }, (_, index) => `Rule ${index}`)
    )
  })

  it('updates every V2 field and normalizes an empty condition to always-on', async () => {
    const rule = await createGuidanceRule({ name: 'Original', instruction: 'Original instruction' })
    const updated = await updateGuidanceRule(rule.id, {
      name: ' Updated ',
      appliesWhen: '\u0000 ',
      instruction: ' Updated instruction ',
      roles: ['copilot_qa'],
      channels: ['copilot'],
      enabled: false,
      priority: 7,
    })

    expect(updated).toMatchObject({
      name: 'Updated',
      appliesWhen: null,
      instruction: 'Updated instruction',
      roles: ['copilot_qa'],
      channels: ['copilot'],
      enabled: false,
      priority: 7,
    })
  })

  it('reorders priorities and deletes rules', async () => {
    const a = await createGuidanceRule({ name: 'A', instruction: 'A body' })
    const b = await createGuidanceRule({ name: 'B', instruction: 'B body' })
    const c = await createGuidanceRule({ name: 'C', instruction: 'C body' })

    await reorderGuidanceRules([c.id, a.id, b.id])
    expect((await listGuidanceRules()).map((rule) => rule.id)).toEqual([c.id, a.id, b.id])

    await deleteGuidanceRule(a.id)
    expect((await listGuidanceRules()).map((rule) => rule.id)).not.toContain(a.id)
  })

  it('rejects invalid and over-limit V2 fields at the service layer', async () => {
    await expect(
      createGuidanceRule({ name: 'x'.repeat(81), instruction: 'Fine.' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(
      createGuidanceRule({ name: 'Fine', appliesWhen: 'x'.repeat(501), instruction: 'Fine.' })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(
      createGuidanceRule({ name: 'Fine', instruction: 'x'.repeat(1_001) })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(
      createGuidanceRule({
        name: 'Fine',
        instruction: 'Fine.',
        roles: ['unknown'] as never,
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})
