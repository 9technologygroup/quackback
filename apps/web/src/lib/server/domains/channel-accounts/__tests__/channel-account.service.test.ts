/**
 * Real-DB coverage for the channel-account service (support platform §4.8 Layer 2):
 * one inbound route per workspace (partial-unique), sending addresses resolved per
 * module, sending-domain verify toggle, and the soft-delete filter. Runs inside the
 * db-test-fixture rollback transaction.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { type TeamId } from '@quackback/ids'

import { createDbTestFixture, testDb } from '@/lib/server/__tests__/db-test-fixture'
import { teams, channelAccounts, emailSendingDomains } from '@/lib/server/db'

vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: (await import('@/lib/server/__tests__/db-test-fixture')).testDb,
}))

import {
  createInboundRoute,
  createSendingAddress,
  createSendingDomain,
  getInboundRoute,
  getSendingAddress,
  getSendingDomain,
  markSendingDomainVerified,
  listChannelAccounts,
  softDeleteChannelAccount,
  resolveChannelAccountByRecipient,
} from '../channel-account.service'

const fixture = await createDbTestFixture({
  probe: async (db) => {
    await db.select({ id: channelAccounts.id }).from(channelAccounts).limit(0)
    await db.select({ id: emailSendingDomains.id }).from(emailSendingDomains).limit(0)
  },
})

const suffix = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

async function seedTeam(): Promise<TeamId> {
  const [team] = await testDb
    .insert(teams)
    .values({ name: `Team-${suffix()}` })
    .returning()
  return team.id
}

describe.skipIf(!fixture.available)('channel-account.service (real DB, rolled back)', () => {
  beforeEach(fixture.begin)
  afterEach(fixture.rollback)
  afterAll(fixture.close)

  it('creates + resolves one inbound route per workspace, and rejects a second', async () => {
    const teamId = await seedTeam()
    const route = await createInboundRoute({
      owningTeamId: teamId,
      config: { forwardingTarget: 'support@acme.com', provider: 'resend' },
    })
    expect(route.role).toBe('inbound')
    expect(route.channel).toBe('email')
    expect(route.inboundTrust).toBe('strict')

    const resolved = await getInboundRoute(teamId)
    expect(resolved?.id).toBe(route.id)
    expect(resolved?.config.forwardingTarget).toBe('support@acme.com')

    // The partial-unique enforces one inbound route per workspace.
    await expect(
      createInboundRoute({ owningTeamId: teamId, config: { provider: 'imap' } })
    ).rejects.toThrow()
  })

  it('resolves a sending address by module', async () => {
    const teamId = await seedTeam()
    await createSendingAddress({
      owningTeamId: teamId,
      address: 'Support@Acme.com',
      module: 'support',
    })
    await createSendingAddress({
      owningTeamId: teamId,
      address: 'ideas@acme.com',
      module: 'feedback',
    })

    const support = await getSendingAddress(teamId, 'support')
    expect(support?.address).toBe('support@acme.com') // lowercased on write
    expect(support?.module).toBe('support')

    const feedback = await getSendingAddress(teamId, 'feedback')
    expect(feedback?.address).toBe('ideas@acme.com')

    expect(await getSendingAddress(teamId, 'changelog')).toBeNull()
  })

  it('creates a sending domain and toggles it verified', async () => {
    const teamId = await seedTeam()
    const domain = await createSendingDomain({
      owningTeamId: teamId,
      domain: 'Mail.Acme.com',
      dnsRecords: [{ type: 'TXT', host: '@', value: 'v=spf1 include:acme -all', purpose: 'spf' }],
    })
    expect(domain.domain).toBe('mail.acme.com')
    expect(domain.status).toBe('pending')
    expect(domain.dnsRecords).toHaveLength(1)

    const verified = await markSendingDomainVerified(domain.id)
    expect(verified.status).toBe('verified')
    expect(verified.verifiedAt).not.toBeNull()
    expect((await getSendingDomain(domain.id))?.status).toBe('verified')
  })

  it('resolves a channel account by a sending address or the inbound forwarding target', async () => {
    const teamId = await seedTeam()
    await createInboundRoute({
      owningTeamId: teamId,
      config: { forwardingTarget: 'inbound@acme.com', provider: 'resend' },
    })
    const sending = await createSendingAddress({
      owningTeamId: teamId,
      address: 'support@acme.com',
      module: 'support',
    })

    // Match a sending address (case-insensitive, display name stripped by caller).
    const bySending = await resolveChannelAccountByRecipient(['Support@Acme.com', 'other@x.com'])
    expect(bySending?.id).toBe(sending.id)

    // Match the inbound route's forwarding target.
    const byInbound = await resolveChannelAccountByRecipient(['inbound@acme.com'])
    expect(byInbound?.role).toBe('inbound')

    // No match, and empty input.
    expect(await resolveChannelAccountByRecipient(['nobody@x.com'])).toBeNull()
    expect(await resolveChannelAccountByRecipient([])).toBeNull()
  })

  it('soft-delete hides an account from the resolver + list', async () => {
    const teamId = await seedTeam()
    const route = await createInboundRoute({ owningTeamId: teamId, config: {} })
    expect(await listChannelAccounts(teamId)).toHaveLength(1)

    await softDeleteChannelAccount(route.id)
    expect(await getInboundRoute(teamId)).toBeNull()
    expect(await listChannelAccounts(teamId)).toHaveLength(0)

    // ...and the partial-unique frees up, so a fresh inbound route can be created.
    await expect(createInboundRoute({ owningTeamId: teamId, config: {} })).resolves.toBeDefined()
  })
})
