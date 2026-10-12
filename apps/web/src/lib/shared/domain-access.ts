import type {
  AccessDomainId,
  DomainAccessChip,
  DomainAccessLevel,
  DomainAccessLevels,
} from './api-key-scopes'

const LEVEL_RANK: Record<DomainAccessLevel, number> = { off: 0, read: 1, read_write: 2, write: 2 }

/** Whether a picker choice stays within the capabilities the client requested. */
export function isChipWithinRequest(
  allowed: DomainAccessLevels,
  domain: AccessDomainId,
  chip: DomainAccessChip
): boolean {
  return LEVEL_RANK[chip] <= LEVEL_RANK[allowed[domain]]
}
