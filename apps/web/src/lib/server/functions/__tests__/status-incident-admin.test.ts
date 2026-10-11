/**
 * getStatusIncidentAdminFn's recipient count. A row published with "Email
 * subscribers" off carries a notified_at too (so an older version's sweep
 * never announces it), so the count must come from the publisher's choice,
 * not from notified_at alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-start', () => ({
  createServerOnlyFn: <T>(fn: T) => fn,
  createServerFn: () => {
    const chain = {
      validator: () => chain,
      handler: (fn: unknown) => fn,
    }
    return chain
  },
}))

vi.mock('../auth-helpers', () => ({
  requireAuth: vi.fn().mockResolvedValue({ principal: { id: 'principal_1' } }),
  getOptionalAuth: vi.fn(),
  policyActorFromAuth: vi.fn(),
}))
vi.mock('../portal-access', () => ({ resolvePortalAccessForRequest: vi.fn() }))
vi.mock('@/lib/server/domains/settings/settings.status', () => ({
  getStatusSettings: vi.fn(),
  updateStatusSettings: vi.fn(),
}))
vi.mock('@/lib/server/domains/settings/tier-enforce', () => ({
  enforceStatusComponentLimit: vi.fn(),
}))

const mockFindIncident = vi.fn()
const mockCountSubscribers = vi.fn()
vi.mock('@/lib/server/domains/status', () => ({
  findStatusIncidentById: (...args: unknown[]) => mockFindIncident(...args),
  countActiveSubscribersForComponents: (...args: unknown[]) => mockCountSubscribers(...args),
}))

import { getStatusIncidentAdminFn } from '../status'

const INCIDENT_ID = 'status_incident_01h455vb4pex5vsknk084sn02q'
const API = 'status_component_01h455vb4pex5vsknk084sn02b'

function incident(overrides: Record<string, unknown>) {
  const at = new Date('2026-10-10T08:00:00.000Z')
  return {
    id: INCIDENT_ID,
    kind: 'incident',
    title: 'Errors',
    status: 'investigating',
    impact: 'major',
    impactOverride: false,
    scheduledStartAt: null,
    scheduledEndAt: null,
    autoStart: true,
    autoComplete: true,
    startedAt: at,
    resolvedAt: null,
    backfilled: false,
    notifiedAt: at,
    notifySubscribers: true,
    createdBy: null,
    createdAt: at,
    updatedAt: at,
    affectedComponents: [
      { componentId: API, componentStatus: 'major_outage', name: 'API', segmentIds: [] },
    ],
    updates: [],
    ...overrides,
  }
}

const getDetail = getStatusIncidentAdminFn as unknown as (args: {
  data: { id: string }
}) => Promise<{ notifiedSubscriberCount: number | null }>

beforeEach(() => {
  mockFindIncident.mockReset()
  mockCountSubscribers.mockReset().mockResolvedValue(42)
})

describe('getStatusIncidentAdminFn recipient count', () => {
  it('counts recipients for a row that was emailed', async () => {
    mockFindIncident.mockResolvedValue(incident({}))
    const detail = await getDetail({ data: { id: INCIDENT_ID } })
    expect(detail.notifiedSubscriberCount).toBe(42)
  })

  it('has none for a row published with "Email subscribers" off', async () => {
    mockFindIncident.mockResolvedValue(incident({ notifySubscribers: false }))
    const detail = await getDetail({ data: { id: INCIDENT_ID } })
    expect(detail.notifiedSubscriberCount).toBeNull()
    expect(mockCountSubscribers).not.toHaveBeenCalled()
  })
})
