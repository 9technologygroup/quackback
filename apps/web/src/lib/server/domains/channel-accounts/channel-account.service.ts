/**
 * Channel accounts + sending domains (support platform §4.8 Layer 2). The email
 * channel's connected instances: one `inbound` route per workspace (the front
 * door a conversation's channel_account_id points at) and N `sending` addresses
 * (the verified From identities per module), plus the SPF/DKIM sending domains.
 *
 * Pure CRUD + resolvers; no permission gate here. The settings UX that creates
 * these (a later slice) gates at the fn layer, like the other domains. Inert
 * until the cold-inbound + outbound slices consume the resolvers.
 */
import {
  db,
  eq,
  and,
  isNull,
  desc,
  channelAccounts,
  emailSendingDomains,
  type ChannelAccount,
  type EmailSendingDomain,
  type ChannelAccountConfig,
  type SendingDomainDnsRecord,
} from '@/lib/server/db'
import type { ChannelAccountId, SendingDomainId, TeamId } from '@quackback/ids'

type SendingModule = 'support' | 'feedback' | 'changelog'

// ---------------------------------------------------------------------------
// Sending domains (SPF/DKIM verified)
// ---------------------------------------------------------------------------

export async function createSendingDomain(input: {
  owningTeamId: TeamId
  domain: string
  dnsRecords?: SendingDomainDnsRecord[]
}): Promise<EmailSendingDomain> {
  const [row] = await db
    .insert(emailSendingDomains)
    .values({
      owningTeamId: input.owningTeamId,
      domain: input.domain.trim().toLowerCase(),
      dnsRecords: input.dnsRecords ?? [],
    })
    .returning()
  return row
}

export async function listSendingDomains(owningTeamId: TeamId): Promise<EmailSendingDomain[]> {
  return db
    .select()
    .from(emailSendingDomains)
    .where(eq(emailSendingDomains.owningTeamId, owningTeamId))
    .orderBy(desc(emailSendingDomains.createdAt))
}

export async function getSendingDomain(id: SendingDomainId): Promise<EmailSendingDomain | null> {
  const [row] = await db
    .select()
    .from(emailSendingDomains)
    .where(eq(emailSendingDomains.id, id))
    .limit(1)
  return row ?? null
}

/**
 * Mark a sending domain verified (§4.8 decision D: a manual toggle in v1; the
 * DNS-record verifier job replaces this in a later slice). Stamps verifiedAt.
 */
export async function markSendingDomainVerified(id: SendingDomainId): Promise<EmailSendingDomain> {
  const now = new Date()
  const [row] = await db
    .update(emailSendingDomains)
    .set({ status: 'verified', verifiedAt: now, lastCheckedAt: now, updatedAt: now })
    .where(eq(emailSendingDomains.id, id))
    .returning()
  return row
}

// ---------------------------------------------------------------------------
// Channel accounts
// ---------------------------------------------------------------------------

/** The workspace's one inbound email route (the partial-unique enforces one). */
export async function createInboundRoute(input: {
  owningTeamId: TeamId
  config: ChannelAccountConfig
  inboundTrust?: 'strict' | 'lenient'
}): Promise<ChannelAccount> {
  const [row] = await db
    .insert(channelAccounts)
    .values({
      owningTeamId: input.owningTeamId,
      role: 'inbound',
      config: input.config,
      inboundTrust: input.inboundTrust ?? 'strict',
    })
    .returning()
  return row
}

/** A verified sending address for a module (the outbound From identity). */
export async function createSendingAddress(input: {
  owningTeamId: TeamId
  address: string
  module: SendingModule
  sendingDomainId?: SendingDomainId
  config?: ChannelAccountConfig
}): Promise<ChannelAccount> {
  const [row] = await db
    .insert(channelAccounts)
    .values({
      owningTeamId: input.owningTeamId,
      role: 'sending',
      address: input.address.trim().toLowerCase(),
      module: input.module,
      sendingDomainId: input.sendingDomainId ?? null,
      config: input.config ?? {},
    })
    .returning()
  return row
}

/** Resolve the workspace's inbound route (the inbox a conversation arrived on). */
export async function getInboundRoute(owningTeamId: TeamId): Promise<ChannelAccount | null> {
  const [row] = await db
    .select()
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.owningTeamId, owningTeamId),
        eq(channelAccounts.role, 'inbound'),
        isNull(channelAccounts.deletedAt)
      )
    )
    .limit(1)
  return row ?? null
}

/** Resolve the sending address for a module (the outbound From for a reply). */
export async function getSendingAddress(
  owningTeamId: TeamId,
  module: SendingModule
): Promise<ChannelAccount | null> {
  const [row] = await db
    .select()
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.owningTeamId, owningTeamId),
        eq(channelAccounts.role, 'sending'),
        eq(channelAccounts.module, module),
        isNull(channelAccounts.deletedAt)
      )
    )
    .limit(1)
  return row ?? null
}

export async function listChannelAccounts(owningTeamId: TeamId): Promise<ChannelAccount[]> {
  return db
    .select()
    .from(channelAccounts)
    .where(and(eq(channelAccounts.owningTeamId, owningTeamId), isNull(channelAccounts.deletedAt)))
    .orderBy(desc(channelAccounts.createdAt))
}

export async function getChannelAccount(id: ChannelAccountId): Promise<ChannelAccount | null> {
  const [row] = await db
    .select()
    .from(channelAccounts)
    .where(and(eq(channelAccounts.id, id), isNull(channelAccounts.deletedAt)))
    .limit(1)
  return row ?? null
}

export async function softDeleteChannelAccount(id: ChannelAccountId): Promise<void> {
  const now = new Date()
  await db
    .update(channelAccounts)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(channelAccounts.id, id), isNull(channelAccounts.deletedAt)))
}
