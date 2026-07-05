import type { ConversationAttributeId } from '@quackback/ids'
import type {
  ConversationAttributeFieldType,
  ConversationAttributeOption,
  ConversationAttributeSourceHint,
} from '@/lib/server/db'

/** A registry definition as surfaced to the settings page and pickers. */
export interface ConversationAttribute {
  id: ConversationAttributeId
  key: string
  label: string
  description: string | null
  fieldType: ConversationAttributeFieldType
  options: ConversationAttributeOption[] | null
  requiredToClose: boolean
  sourceHint: ConversationAttributeSourceHint | null
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** A new option: the stable id is generated server-side. */
export interface CreateAttributeOptionInput {
  label: string
  description?: string | null
}

/**
 * An option on update: with `id` it renames/redescribes the existing option,
 * without one it appends a new option. Existing ids may never be omitted
 * (values store option ids, so removal would orphan them).
 */
export interface UpdateAttributeOptionInput {
  id?: string
  label: string
  description?: string | null
}

export interface CreateConversationAttributeInput {
  key: string
  label: string
  description?: string | null
  fieldType: ConversationAttributeFieldType
  options?: CreateAttributeOptionInput[]
  requiredToClose?: boolean
  sourceHint?: ConversationAttributeSourceHint | null
}

/** Field type is immutable after creation, so it is not updatable. */
export interface UpdateConversationAttributeInput {
  label?: string
  description?: string | null
  options?: UpdateAttributeOptionInput[]
  requiredToClose?: boolean
  sourceHint?: ConversationAttributeSourceHint | null
}
