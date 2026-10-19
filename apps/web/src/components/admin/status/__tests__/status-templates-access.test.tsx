// @vitest-environment happy-dom
/**
 * Publishers read templates (the composers insert them), but only
 * status_page.manage adds, edits or deletes them. A publisher sees the list
 * without those actions, and the form's manage-only service list is never
 * read for them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

let permissions: string[] = []
const queried: string[] = []

const TEMPLATE = {
  id: 'status_incident_template_1',
  name: 'API outage',
  title: 'API errors',
  body: 'We are investigating.',
  impact: 'major',
  componentIds: [],
  usageCount: 2,
}

vi.mock('@tanstack/react-router', () => ({
  useRouteContext: ({ select }: { select: (context: unknown) => unknown }) =>
    select({ permissions }),
}))
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryKey: string[] }) => {
    queried.push(opts.queryKey.join('/'))
    return opts.queryKey.includes('templates')
      ? { data: [TEMPLATE], isLoading: false }
      : { data: undefined, isLoading: false }
  },
}))
vi.mock('@/lib/client/queries/status', () => ({
  statusTemplateQueries: { list: () => ({ queryKey: ['status', 'templates'] }) },
  statusComponentQueries: { list: () => ({ queryKey: ['status', 'components'] }) },
}))
vi.mock('@/lib/client/mutations/status', () => ({
  useCreateStatusIncidentTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateStatusIncidentTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteStatusIncidentTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

import { StatusTemplatesView } from '../status-templates-view'

beforeEach(() => {
  queried.length = 0
})
afterEach(cleanup)

describe('StatusTemplatesView access', () => {
  it('lists templates for a publisher without offering to add, edit or delete them', () => {
    permissions = ['status_page.publish']
    const { container } = render(<StatusTemplatesView />)

    expect(screen.getByText('API outage')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /New template/ })).toBeNull()
    // No row actions (edit, delete) at all.
    expect(container.querySelectorAll('.group button')).toHaveLength(0)
    expect(queried).not.toContain('status/components')
  })

  it('offers the actions to a role that can manage the page', () => {
    permissions = ['status_page.publish', 'status_page.manage']
    const { container } = render(<StatusTemplatesView />)

    expect(screen.getByRole('button', { name: /New template/ })).toBeTruthy()
    expect(container.querySelectorAll('.group button')).toHaveLength(2)
  })
})
