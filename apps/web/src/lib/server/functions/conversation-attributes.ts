/**
 * Server functions for conversation attribute definitions + values. Reading
 * the registry needs conversation.view (every picker and the inbox panel);
 * defining/archiving needs conversation.manage; writing a VALUE onto a
 * conversation needs conversation.set_attributes and always records
 * src 'teammate' (workflow/AI writers call the domain writer directly).
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import type { ConversationAttributeId, ConversationId } from '@quackback/ids'
import { requireAuth } from './auth-helpers'
import { PERMISSIONS } from '@/lib/shared/permissions'
import {
  listConversationAttributes,
  createConversationAttribute,
  updateConversationAttribute,
  archiveConversationAttribute,
  restoreConversationAttribute,
} from '@/lib/server/domains/conversation-attributes/conversation-attribute.service'
import { setConversationAttribute } from '@/lib/server/domains/conversation-attributes/set-attribute.service'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'conversation-attributes-fns' })

const fieldTypeSchema = z.enum(['text', 'number', 'select', 'multi_select', 'checkbox', 'date'])
const sourceHintSchema = z.enum(['ai', 'workflow', 'agent'])

const createOptionSchema = z.object({
  label: z.string().min(1).max(100),
  description: z.string().max(512).optional().nullable(),
})
const updateOptionSchema = createOptionSchema.extend({
  id: z.string().min(1).optional(),
})

const listAttributesSchema = z.object({ includeArchived: z.boolean().optional() }).optional()

const createAttributeSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
  description: z.string().max(512).optional().nullable(),
  fieldType: fieldTypeSchema,
  options: z.array(createOptionSchema).max(100).optional(),
  requiredToClose: z.boolean().optional(),
  sourceHint: sourceHintSchema.optional().nullable(),
})

// Field type (and key) are immutable after creation, so neither is accepted.
const updateAttributeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(128).optional(),
  description: z.string().max(512).optional().nullable(),
  options: z.array(updateOptionSchema).max(100).optional(),
  requiredToClose: z.boolean().optional(),
  sourceHint: sourceHintSchema.optional().nullable(),
})

const attributeIdSchema = z.object({ id: z.string().min(1) })

const setAttributeValueSchema = z.object({
  conversationId: z.string().min(1),
  key: z.string().min(1).max(64),
  // Typed validation happens against the definition in the domain writer.
  value: z.unknown(),
})

/** Definitions for pickers + the inbox panel (non-archived by default). */
export const listConversationAttributesFn = createServerFn({ method: 'GET' })
  .validator(listAttributesSchema)
  .handler(async ({ data }) => {
    try {
      await requireAuth({ permission: PERMISSIONS.CONVERSATION_VIEW })
      return listConversationAttributes({ includeArchived: data?.includeArchived })
    } catch (error) {
      log.error({ err: error }, 'list conversation attributes failed')
      throw error
    }
  })

export const createConversationAttributeFn = createServerFn({ method: 'POST' })
  .validator(createAttributeSchema)
  .handler(async ({ data }) => {
    try {
      await requireAuth({ permission: PERMISSIONS.CONVERSATION_MANAGE })
      return createConversationAttribute(data)
    } catch (error) {
      log.error({ err: error }, 'create conversation attribute failed')
      throw error
    }
  })

export const updateConversationAttributeFn = createServerFn({ method: 'POST' })
  .validator(updateAttributeSchema)
  .handler(async ({ data }) => {
    try {
      await requireAuth({ permission: PERMISSIONS.CONVERSATION_MANAGE })
      const { id, ...input } = data
      return updateConversationAttribute(id as ConversationAttributeId, input)
    } catch (error) {
      log.error({ err: error }, 'update conversation attribute failed')
      throw error
    }
  })

export const archiveConversationAttributeFn = createServerFn({ method: 'POST' })
  .validator(attributeIdSchema)
  .handler(async ({ data }) => {
    try {
      await requireAuth({ permission: PERMISSIONS.CONVERSATION_MANAGE })
      return archiveConversationAttribute(data.id as ConversationAttributeId)
    } catch (error) {
      log.error({ err: error }, 'archive conversation attribute failed')
      throw error
    }
  })

export const restoreConversationAttributeFn = createServerFn({ method: 'POST' })
  .validator(attributeIdSchema)
  .handler(async ({ data }) => {
    try {
      await requireAuth({ permission: PERMISSIONS.CONVERSATION_MANAGE })
      return restoreConversationAttribute(data.id as ConversationAttributeId)
    } catch (error) {
      log.error({ err: error }, 'restore conversation attribute failed')
      throw error
    }
  })

/** Teammate inline edit from the inbox panel: one attribute value. */
export const setConversationAttributeValueFn = createServerFn({ method: 'POST' })
  .validator(setAttributeValueSchema)
  .handler(async ({ data }) => {
    try {
      await requireAuth({ permission: PERMISSIONS.CONVERSATION_SET_ATTRIBUTES })
      const customAttributes = await setConversationAttribute(
        { conversationId: data.conversationId as ConversationId },
        data.key,
        data.value ?? null,
        'teammate'
      )
      return { customAttributes }
    } catch (error) {
      log.error({ err: error }, 'set conversation attribute value failed')
      throw error
    }
  })
