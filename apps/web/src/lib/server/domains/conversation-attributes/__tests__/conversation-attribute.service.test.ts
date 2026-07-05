/**
 * Real-DB coverage for the conversation-attribute registry: key normalization,
 * unique keys (archived keys stay reserved), per-type option rules, option
 * append/rename-by-id (never removal), and the archive/restore lifecycle.
 * Runs inside the db-test-fixture rollback transaction.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'

import { createDbTestFixture } from '@/lib/server/__tests__/db-test-fixture'
import { conversationAttributeDefinitions } from '@/lib/server/db'

vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

import {
  normalizeAttributeKey,
  listConversationAttributes,
  createConversationAttribute,
  updateConversationAttribute,
  archiveConversationAttribute,
  restoreConversationAttribute,
} from '../conversation-attribute.service'

const fixture = await createDbTestFixture({
  probe: async (db) => {
    await db
      .select({ id: conversationAttributeDefinitions.id })
      .from(conversationAttributeDefinitions)
      .limit(0)
  },
})

describe('normalizeAttributeKey', () => {
  it('lowercases, trims, and snake_cases whitespace', () => {
    expect(normalizeAttributeKey('  Issue Type ')).toBe('issue_type')
    expect(normalizeAttributeKey('MRR')).toBe('mrr')
  })
})

describe.skipIf(!fixture.available)(
  'conversation-attribute registry (real DB, rolled back)',
  () => {
    beforeEach(fixture.begin)
    afterEach(fixture.rollback)
    afterAll(fixture.close)

    it('creates a text attribute with a normalized key', async () => {
      const created = await createConversationAttribute({
        key: 'Issue Type',
        label: 'Issue type',
        description: 'What the conversation is about',
        fieldType: 'text',
      })
      expect(created.key).toBe('issue_type')
      expect(created.fieldType).toBe('text')
      expect(created.options).toBeNull()
      expect(created.requiredToClose).toBe(false)
      expect(created.archivedAt).toBeNull()
    })

    it('creates a select attribute with generated stable option ids', async () => {
      const created = await createConversationAttribute({
        key: 'severity',
        label: 'Severity',
        fieldType: 'select',
        options: [
          { label: 'Low', description: 'Cosmetic' },
          { label: 'High', description: 'Blocking' },
        ],
      })
      expect(created.options).toHaveLength(2)
      const ids = created.options!.map((o) => o.id)
      expect(new Set(ids).size).toBe(2)
      expect(ids.every((id) => id.length > 0)).toBe(true)
      expect(created.options![0]).toMatchObject({ label: 'Low', description: 'Cosmetic' })
    })

    it('rejects options on scalar types and requires them on select types', async () => {
      await expect(
        createConversationAttribute({
          key: 'count',
          label: 'Count',
          fieldType: 'number',
          options: [{ label: 'One' }],
        })
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
      await expect(
        createConversationAttribute({ key: 'sev', label: 'Sev', fieldType: 'select' })
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    })

    it('rejects a duplicate key, including one held by an archived definition', async () => {
      const created = await createConversationAttribute({
        key: 'plan',
        label: 'Plan',
        fieldType: 'text',
      })
      await archiveConversationAttribute(created.id)
      // Archived definitions keep their key reserved.
      await expect(
        createConversationAttribute({ key: 'Plan', label: 'Plan again', fieldType: 'number' })
      ).rejects.toMatchObject({ code: 'DUPLICATE_KEY' })
    })

    it('appends and renames options by id but never drops one', async () => {
      const created = await createConversationAttribute({
        key: 'severity',
        label: 'Severity',
        fieldType: 'select',
        options: [{ label: 'Low' }, { label: 'High' }],
      })
      const [low, high] = created.options!

      const updated = await updateConversationAttribute(created.id, {
        options: [
          { id: low.id, label: 'Minor', description: 'Renamed' },
          { id: high.id, label: 'High' },
          { label: 'Critical' },
        ],
      })
      expect(updated.options).toHaveLength(3)
      expect(updated.options![0]).toMatchObject({
        id: low.id,
        label: 'Minor',
        description: 'Renamed',
      })
      expect(updated.options![2].id).not.toBe(low.id)

      // Omitting an existing option id is a removal — refused (values store ids).
      await expect(
        updateConversationAttribute(created.id, { options: [{ id: low.id, label: 'Minor' }] })
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
      // Unknown ids can't be smuggled in either.
      await expect(
        updateConversationAttribute(created.id, {
          options: [
            { id: low.id, label: 'Minor' },
            { id: high.id, label: 'High' },
            { id: 'opt_unknown', label: 'Ghost' },
          ],
        })
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    })

    it('keeps the field type immutable', async () => {
      const created = await createConversationAttribute({
        key: 'plan',
        label: 'Plan',
        fieldType: 'text',
      })
      await expect(
        updateConversationAttribute(created.id, {
          fieldType: 'number',
        } as unknown as Parameters<typeof updateConversationAttribute>[1])
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    })

    it('archives (hidden from the default list) and restores', async () => {
      const created = await createConversationAttribute({
        key: 'plan',
        label: 'Plan',
        fieldType: 'text',
      })
      const archived = await archiveConversationAttribute(created.id)
      expect(archived.archivedAt).not.toBeNull()

      const defaultList = await listConversationAttributes()
      expect(defaultList.find((a) => a.id === created.id)).toBeUndefined()
      const fullList = await listConversationAttributes({ includeArchived: true })
      expect(fullList.find((a) => a.id === created.id)).toBeDefined()

      const restored = await restoreConversationAttribute(created.id)
      expect(restored.archivedAt).toBeNull()
      const listAgain = await listConversationAttributes()
      expect(listAgain.find((a) => a.id === created.id)).toBeDefined()
    })
  }
)
