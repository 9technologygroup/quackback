/**
 * CSV export for the audit-log table.
 *
 * The 0070_audit_log_observability migration added request_id (indexed
 * for cross-event forensics), actor_type, and auth_method. These must
 * appear in the CSV export — the export is the operator's primary
 * offline-forensics tool, so leaving the new columns out keeps them
 * effectively invisible.
 */
import { describe, it, expect } from 'vitest'
import { rowsToCsv } from '../audit-log-page'
import type { AuditEventRow } from '@/lib/server/functions/audit-log'

function row(overrides: Partial<AuditEventRow> = {}): AuditEventRow {
  return {
    id: 'audit_1',
    occurredAt: '2026-05-20T10:30:00.000Z',
    actorUserId: null,
    actorEmail: 'demo@example.com',
    actorRole: 'admin',
    actorIp: '127.0.0.1',
    actorUserAgent: 'Mozilla/5.0',
    eventType: 'auth.signin.succeeded',
    eventOutcome: 'success',
    targetType: null,
    targetId: null,
    beforeValue: null,
    afterValue: null,
    metadata: null,
    requestId: null,
    actorType: null,
    authMethod: null,
    channel: null,
    credentialKind: null,
    credentialId: null,
    clientName: null,
    onBehalfOfPrincipalId: null,
    onBehalfOfName: null,
    ...overrides,
  }
}

describe('rowsToCsv — audit-log observability columns', () => {
  it('includes request_id, actor_type, auth_method in the header row', () => {
    const csv = rowsToCsv([row()])
    const [header] = csv.split('\n')
    expect(header).toContain('request_id')
    expect(header).toContain('actor_type')
    expect(header).toContain('auth_method')
  })

  it('emits the values in each data row', () => {
    const csv = rowsToCsv([row({ requestId: 'req_abc123', actorType: 'user', authMethod: 'sso' })])
    const [, dataRow] = csv.split('\n')
    expect(dataRow).toContain('req_abc123')
    expect(dataRow).toContain('user')
    expect(dataRow).toContain('sso')
  })

  it('emits empty cells (not "null") when the observability fields are null', () => {
    const csv = rowsToCsv([row({ requestId: null, actorType: null, authMethod: null })])
    // Should not contain the literal string "null" — empty CSV cell instead.
    expect(csv).not.toMatch(/,null,/)
    expect(csv).not.toMatch(/,null$/)
  })
})

describe('rowsToCsv: attribution columns', () => {
  it('exports how each change arrived, which credential made it and for whom', () => {
    const csv = rowsToCsv([
      row({
        eventType: 'mcp.tool_call',
        channel: 'mcp',
        credentialKind: 'oauth_client',
        credentialId: 'client_desktop',
        clientName: 'Claude Desktop',
        onBehalfOfPrincipalId: 'principal_01h455vb4pex5vsknk084sn02r',
        onBehalfOfName: 'James Morton',
      }),
    ])
    const [header, dataRow] = csv.split('\n')
    const columns = header.split(',')
    const cells = dataRow.split(',')
    const cell = (name: string) => cells[columns.indexOf(name)]
    expect(cell('channel')).toBe('mcp')
    expect(cell('credential_kind')).toBe('oauth_client')
    expect(cell('credential_id')).toBe('client_desktop')
    expect(cell('client_name')).toBe('Claude Desktop')
    expect(cell('on_behalf_of_principal_id')).toBe('principal_01h455vb4pex5vsknk084sn02r')
    expect(cell('on_behalf_of')).toBe('James Morton')
  })
})

describe('rowsToCsv: spreadsheet formula injection', () => {
  it('neutralises any cell a spreadsheet would read as a formula, in every column', () => {
    const csv = rowsToCsv([
      row({
        actorEmail: '@SUM(1+1)',
        targetType: '+cmd',
        targetId: '-2+3',
        clientName: '=HYPERLINK("https://evil.example","Claude")',
        credentialId: '\tclient',
        requestId: '\rreq',
      }),
    ])
    const [header, dataRow] = csv.split('\n')
    const columns = header.split(',')
    const cells = dataRow.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    const cell = (name: string) => cells[columns.indexOf(name)]
    expect(cell('actor_email')).toBe("'@SUM(1+1)")
    expect(cell('target_type')).toBe("'+cmd")
    expect(cell('target_id')).toBe("'-2+3")
    expect(cell('client_name')).toBe('"\'=HYPERLINK(""https://evil.example"",""Claude"")"')
    expect(cell('credential_id')).toBe("'\tclient")
    expect(cell('request_id')).toBe('"\'\rreq"')
  })

  it('leaves ordinary values alone', () => {
    const csv = rowsToCsv([row({ clientName: 'Claude Desktop', targetId: 'post_01h455' })])
    expect(csv).toContain(',Claude Desktop,')
    expect(csv).toContain(',post_01h455,')
  })
})
