/**
 * The report-incident dialog shows impact as a derived, read-only note
 * ("Impact: Major, derived from the worst affected service") computed
 * client-side while the user picks services. This pins the client mirror
 * to the server's deriveImpact so the preview can never disagree with
 * what createIncident actually stores.
 */
import { describe, it, expect } from 'vitest'
import { deriveImpact } from '@/lib/server/domains/status/status.calc'
import { COMPONENT_STATUS_VALUES, deriveImpactFromStatuses } from '../status-admin-colors'

describe('deriveImpactFromStatuses parity with server deriveImpact', () => {
  it('matches for every single status', () => {
    for (const status of COMPONENT_STATUS_VALUES) {
      expect(deriveImpactFromStatuses([status])).toBe(deriveImpact([status]))
    }
  })

  it('matches for every pair of statuses', () => {
    for (const a of COMPONENT_STATUS_VALUES) {
      for (const b of COMPONENT_STATUS_VALUES) {
        expect(deriveImpactFromStatuses([a, b])).toBe(deriveImpact([a, b]))
      }
    }
  })

  it('matches for the empty selection', () => {
    expect(deriveImpactFromStatuses([])).toBe(deriveImpact([]))
  })
})
