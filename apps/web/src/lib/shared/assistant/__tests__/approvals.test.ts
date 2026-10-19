import { describe, expect, it } from 'vitest'
import { createId } from '@quackback/ids'
import { approvalIdFromReference, approvalPath } from '../approvals'

describe('the approval page', () => {
  const id = createId('assistant_action')

  it('opens the Approvals page on the request, by its id', () => {
    expect(approvalPath(id)).toBe(`/admin/approvals?id=${id}`)
  })

  it('reads the id back from the url it builds, absolute or relative', () => {
    expect(approvalIdFromReference(`https://acme.example.com${approvalPath(id)}`)).toBe(id)
    expect(approvalIdFromReference(approvalPath(id))).toBe(id)
    expect(approvalIdFromReference(`https://acme.example.com/admin/approvals/?id=${id}`)).toBe(id)
  })

  it('reads a bare id, and the older path form', () => {
    expect(approvalIdFromReference(` ${id} `)).toBe(id)
    expect(approvalIdFromReference(`https://acme.example.com/admin/approvals/${id}`)).toBe(id)
    expect(approvalIdFromReference(`/admin/approvals/${id}/`)).toBe(id)
  })

  it('refuses anything that is not an approval reference', () => {
    for (const reference of [
      '',
      'not-an-id',
      createId('post'),
      `https://acme.example.com/admin/inbox?id=${id}`,
      `https://acme.example.com/admin/approvals?id=${createId('post')}`,
      `https://acme.example.com/admin/approvals`,
      `https://acme.example.com/admin/approvals-old/${id}`,
    ]) {
      expect(approvalIdFromReference(reference), reference).toBeNull()
    }
  })
})
