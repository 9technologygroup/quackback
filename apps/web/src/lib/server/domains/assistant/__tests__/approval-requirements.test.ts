/**
 * The per-read cache of what each request needs: it may share a lookup only
 * between rows whose requirement is the same, which for a tool depends on the
 * role that proposed it and the kind of thread it came from.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createId } from '@quackback/ids'

const lookups = vi.hoisted(() => ({ count: 0 }))

vi.mock('../approvals.service', async (original) => ({
  ...(await original<typeof import('../approvals.service')>()),
  // Stands in for the connector and tool lookups: the answer depends on
  // exactly the fields the real lookup reads.
  requiredApprovalPermissions: async (row: {
    toolName: string
    originRole: string
    workspaceThreadKey: string | null
    args: Record<string, unknown>
  }) => {
    lookups.count += 1
    return new Set([
      `${row.toolName}|${row.originRole}|${row.workspaceThreadKey ?? ''}|${JSON.stringify(row.args)}`,
    ])
  },
}))

import { approvalRequirements } from '../approvals.queue'

type Row = Parameters<ReturnType<typeof approvalRequirements>>[0]

function row(overrides: Partial<Row>): Row {
  return {
    id: createId('assistant_action'),
    toolName: 'mcp__crm__update_deal',
    originRole: 'customer_support',
    workspaceThreadKey: null,
    args: {},
    ...overrides,
  } as Row
}

beforeEach(() => {
  lookups.count = 0
})

describe('approvalRequirements', () => {
  it('keeps a tool proposed by different roles apart', async () => {
    const requirementsOf = approvalRequirements()
    const support = await requirementsOf(row({ originRole: 'customer_support' }))
    const copilot = await requirementsOf(row({ originRole: 'copilot_qa' }))
    expect(support).not.toEqual(copilot)
    expect(lookups.count).toBe(2)
  })

  it('keeps a Home thread, another thread and no thread apart', async () => {
    const requirementsOf = approvalRequirements()
    const role = { originRole: 'workspace_assistant' as const }
    const home = await requirementsOf(row({ ...role, workspaceThreadKey: 'workspace:a' }))
    const slack = await requirementsOf(row({ ...role, workspaceThreadKey: 'slack:T1:C1' }))
    const none = await requirementsOf(row({ ...role, workspaceThreadKey: null }))
    expect(new Set([home, slack, none].map((set) => [...set!][0])).size).toBe(3)
    expect(lookups.count).toBe(3)
  })

  it('reads a tool once for rows that need the same', async () => {
    const requirementsOf = approvalRequirements()
    await requirementsOf(row({ workspaceThreadKey: 'workspace:a' }))
    await requirementsOf(row({ workspaceThreadKey: 'workspace:b' }))
    await requirementsOf(row({}))
    await requirementsOf(row({}))
    expect(lookups.count).toBe(2)
  })

  it('reads every settings request on its own, since each names its own changes', async () => {
    const requirementsOf = approvalRequirements()
    const settings = {
      toolName: 'propose_settings_change',
      originRole: 'workspace_assistant' as const,
    }
    const name = await requirementsOf(row({ ...settings, args: { changes: ['portal'] } }))
    const hours = await requirementsOf(row({ ...settings, args: { changes: ['office_hours'] } }))
    expect(name).not.toEqual(hours)
    expect(lookups.count).toBe(2)
  })
})
