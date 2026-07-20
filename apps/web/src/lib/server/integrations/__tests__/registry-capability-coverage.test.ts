/**
 * Registry ↔ out-of-registry-switch drift gate. Two provider capabilities
 * still live in hand-maintained switch statements outside the
 * IntegrationDefinition contract — webhook auto-registration
 * (functions/status-sync.ts) and external status lists
 * (functions/external-statuses.ts) — and both silently no-op for a provider
 * missing a case. This suite pins their declared coverage sets against the
 * registry so adding an inbound-capable provider without deciding its
 * webhook-setup and status-list story is a CI failure, not a silent gap.
 * (The real fix — folding both into IntegrationDefinition — is a named
 * follow-up; this is the stopgap that stops the rot.)
 */
import { describe, it, expect } from 'vitest'
import { getIntegration, listIntegrationTypes } from '../index'
import {
  AUTO_WEBHOOK_REGISTRATION_PROVIDERS,
  MANUAL_WEBHOOK_PROVIDERS,
} from '@/lib/server/functions/status-sync'
import { EXTERNAL_STATUS_PROVIDERS } from '@/lib/server/functions/external-statuses'

/** Inbound-capable providers whose config UI ships no status-mapping surface
 *  yet — a real, documented gap (their configs never mount StatusSyncConfig).
 *  Closing one means removing it here AND adding its statuses case + UI. */
const KNOWN_STATUS_LIST_GAPS = new Set(['gitlab', 'trello'])

const inboundProviders = listIntegrationTypes().filter((t) => getIntegration(t)?.inbound)

describe('registry capability coverage', () => {
  it('has inbound providers to check (guard against a silently empty registry)', () => {
    expect(inboundProviders.length).toBeGreaterThanOrEqual(9)
  })

  it('every inbound provider declares webhookRegistration (WO-2: setup story lives in the registry)', () => {
    for (const type of inboundProviders) {
      const registration = getIntegration(type)?.webhookRegistration
      expect(
        registration,
        `${type} has inbound but no webhookRegistration — declare 'manual' or { register, unregister }`
      ).toBeTruthy()
    }
  })

  it('webhookRegistration is declared only by inbound providers', () => {
    for (const type of listIntegrationTypes()) {
      if (getIntegration(type)?.webhookRegistration) {
        expect(
          getIntegration(type)?.inbound,
          `${type} declares webhookRegistration but has no inbound handler`
        ).toBeTruthy()
      }
    }
  })

  it('the derived auto/manual sets match the expected split', () => {
    // The exact split that lived in status-sync.ts's hand-maintained sets.
    expect([...AUTO_WEBHOOK_REGISTRATION_PROVIDERS].sort()).toEqual(
      ['asana', 'clickup', 'github', 'jira', 'linear'].sort()
    )
    expect([...MANUAL_WEBHOOK_PROVIDERS].sort()).toEqual(
      ['azure_devops', 'gitlab', 'shortcut', 'trello'].sort()
    )
  })

  it('every inbound provider has an external-status source or a documented gap', () => {
    for (const type of inboundProviders) {
      expect(
        EXTERNAL_STATUS_PROVIDERS.has(type) || KNOWN_STATUS_LIST_GAPS.has(type),
        `${type} has inbound but no external-status source — add a case in ` +
          `external-statuses.ts (and EXTERNAL_STATUS_PROVIDERS) or document the gap here`
      ).toBe(true)
    }
  })

  it('documented status-list gaps stay gaps (stale exemptions must be removed)', () => {
    for (const type of KNOWN_STATUS_LIST_GAPS) {
      expect(
        EXTERNAL_STATUS_PROVIDERS.has(type),
        `${type} now has a status source — remove it from KNOWN_STATUS_LIST_GAPS`
      ).toBe(false)
    }
  })

  it('every tracker provider declares archive (WO-1: archive dispatch lives in the registry)', () => {
    // The exact set that lived in archive.ts's hand-keyed archiveFns table.
    const ARCHIVE_PROVIDERS = new Set([
      'linear',
      'github',
      'jira',
      'gitlab',
      'clickup',
      'asana',
      'shortcut',
      'azure_devops',
      'trello',
      'notion',
      'monday',
    ])
    for (const type of ARCHIVE_PROVIDERS) {
      expect(
        getIntegration(type)?.archive,
        `${type} must declare .archive (close/archive the linked item on post delete)`
      ).toBeTypeOf('function')
    }
    for (const type of listIntegrationTypes()) {
      if (getIntegration(type)?.archive) {
        expect(
          ARCHIVE_PROVIDERS.has(type),
          `${type} declares .archive — add it to ARCHIVE_PROVIDERS so the set stays exact`
        ).toBe(true)
      }
    }
  })

  it('issue capabilities keep their inbound-namespace contract', () => {
    // A provider offering parseRef must have inbound (the parsed externalId
    // exists to serve inbound reverse lookup); create-only providers (e.g.
    // Monday/Notion, if ever) are fine without.
    for (const type of listIntegrationTypes()) {
      const def = getIntegration(type)
      if (def?.issues?.parseRef) {
        expect(def.inbound, `${type} has issues.parseRef but no inbound handler`).toBeTruthy()
      }
    }
  })
})
