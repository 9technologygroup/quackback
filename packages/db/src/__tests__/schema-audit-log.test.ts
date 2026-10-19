import { describe, it, expect } from 'vitest'
import { getTableName, getTableColumns } from 'drizzle-orm'
import { auditLog } from '../schema/audit-log'

describe('audit_log schema', () => {
  it('has correct table name', () => {
    expect(getTableName(auditLog)).toBe('audit_log')
  })

  it('exposes actor, event, target, and value columns', () => {
    const columns = Object.keys(getTableColumns(auditLog))
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'occurredAt',
        'actorUserId',
        'actorEmail',
        'actorRole',
        'actorIp',
        'actorUserAgent',
        'eventType',
        'eventOutcome',
        'targetType',
        'targetId',
        'beforeValue',
        'afterValue',
        'metadata',
      ])
    )
  })

  it('outcome and event type are not null', () => {
    const cols = getTableColumns(auditLog)
    expect(cols.eventType.notNull).toBe(true)
    expect(cols.eventOutcome.notNull).toBe(true)
    expect(cols.occurredAt.notNull).toBe(true)
  })

  it('exposes nullable attribution columns: channel, credential, client and on-behalf-of', () => {
    const cols = getTableColumns(auditLog)
    expect(cols.channel.name).toBe('channel')
    expect(cols.credentialKind.name).toBe('credential_kind')
    expect(cols.credentialId.name).toBe('credential_id')
    expect(cols.clientName.name).toBe('client_name')
    expect(cols.onBehalfOfPrincipalId.name).toBe('on_behalf_of_principal_id')
    for (const col of [
      cols.channel,
      cols.credentialKind,
      cols.credentialId,
      cols.clientName,
      cols.onBehalfOfPrincipalId,
    ]) {
      expect(col.notNull).toBe(false)
      expect(col.hasDefault).toBe(false)
    }
  })

  it('actor user is nullable so we keep rows when admins are removed', () => {
    const cols = getTableColumns(auditLog)
    expect(cols.actorUserId.notNull).toBe(false)
  })
})
