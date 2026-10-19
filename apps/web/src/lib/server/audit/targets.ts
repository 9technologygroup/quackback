/**
 * Audit targets a boundary can name without reading anything: an id it was
 * handed is a target when it is a TypeID, whose prefix says what it names.
 */
import { getTypeIdPrefix, isValidTypeId } from '@quackback/ids'
import type { AuditTarget } from './log'

/** The target a TypeID names, or null for anything that is not one. */
export function typeIdTarget(value: unknown): AuditTarget | null {
  if (typeof value !== 'string' || !isValidTypeId(value)) return null
  return { type: getTypeIdPrefix(value), id: value }
}
