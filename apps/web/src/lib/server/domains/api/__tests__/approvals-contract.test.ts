import { describe, expect, it } from 'vitest'
import '../schemas'
import { generateOpenAPISpec } from '../openapi'
import { APPROVAL_STATUSES } from '@/lib/shared/assistant/approvals'
import { getEventDefinition } from '@/lib/server/events/catalogue'
import { ApprovalSchema } from '../schemas/approvals'

describe('approvals OpenAPI contract', () => {
  const spec = generateOpenAPISpec()
  const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>
  const list = paths['/approvals'] as { get?: Record<string, unknown> } | undefined
  const one = paths['/approvals/{approvalId}'] as { get?: Record<string, unknown> } | undefined

  it('documents reading one approval and the list, and nothing that decides', () => {
    expect(list).toHaveProperty('get')
    expect(one).toHaveProperty('get')
    for (const path of ['/approvals', '/approvals/{approvalId}']) {
      for (const method of ['post', 'put', 'patch', 'delete']) {
        expect(paths[path], `${method} ${path}`).not.toHaveProperty(method)
      }
    }
    expect(Object.keys(paths).filter((path) => path.startsWith('/approvals'))).toEqual([
      '/approvals',
      '/approvals/{approvalId}',
    ])
  })

  it('documents every field of an approval, the url included', () => {
    const response = JSON.stringify(one?.get?.responses)
    for (const field of [
      'status',
      'risk',
      'toolName',
      'title',
      'summary',
      'changes',
      'field',
      'from',
      'to',
      'requestedById',
      'onBehalfOfPrincipalId',
      'requestedVia',
      'clientName',
      'createdAt',
      'expiresAt',
      'decidedById',
      'decidedAt',
      'decidedVia',
      'reason',
      'undoneAt',
      'url',
    ]) {
      expect(response, field).toContain(`"${field}"`)
    }
    for (const status of APPROVAL_STATUSES) expect(response).toContain(`"${status}"`)
    // The example url is the form the Approvals page opens on.
    expect(response).toContain('/admin/approvals?id=assistant_action_')
    expect(JSON.stringify(one?.get?.responses?.['404' as never])).toBeTruthy()
  })

  it('pages the list and filters it by status', () => {
    const params = JSON.stringify(list?.get?.parameters)
    expect(params).toContain('"cursor"')
    expect(params).toContain('"limit"')
    expect(params).toContain('"status"')
    for (const status of APPROVAL_STATUSES) expect(params).toContain(`"${status}"`)
    expect(JSON.stringify(list?.get?.responses)).toContain('"pagination"')
  })

  it('states who sees what, and keeps em dashes out of the public text', () => {
    const description = String(list?.get?.description)
    expect(description).toContain('filed')
    expect(description).toContain('creator')
    // A call reads a bounded number of rows, so a short page can still have more.
    expect(description).toContain('fewer items than limit')
    expect(JSON.stringify({ list, one })).not.toContain(String.fromCharCode(0x2014))
  })

  it('has an Approvals tag', () => {
    expect(spec.tags?.map((tag) => tag.name)).toContain('Approvals')
  })

  it('names every field it shares with the approval webhooks the same way', () => {
    // A webhook names the approval it is about; a REST resource names itself
    // `id`. The decision is the status, and whoever applied it decided it.
    const renamed: Record<string, string> = {
      approvalId: 'id',
      decision: 'status',
      appliedById: 'decidedById',
    }
    const fields = Object.keys(ApprovalSchema.shape)
    for (const type of ['approval.requested', 'approval.decided', 'approval.applied'] as const) {
      const payload = getEventDefinition(type)!.payload as unknown as { shape: object }
      for (const key of Object.keys(payload.shape)) {
        expect(fields, `${type}.${key}`).toContain(renamed[key] ?? key)
      }
    }
  })
})
