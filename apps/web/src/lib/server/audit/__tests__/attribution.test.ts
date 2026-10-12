/**
 * The per-request attribution context: who made a change, through what, and
 * for whom. Boundaries set it once; every audit write reads it.
 */
import { describe, it, expect } from 'vitest'
import type { ApiKeyId, PrincipalId } from '@quackback/ids'
import {
  apiKeyAttribution,
  auditAttributionColumns,
  getAuditAttribution,
  getAuditBoundaryActor,
  oauthClientAttribution,
  runWithAuditAttribution,
  setAuditAttribution,
  SYSTEM_ATTRIBUTION,
  UI_ATTRIBUTION,
} from '../attribution'

const CREATOR = 'principal_01h455vb4pex5vsknk084sn02r' as PrincipalId
const KEY_ID = 'apikey_01h455vb4pex5vsknk084sn02q' as ApiKeyId

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

describe('audit attribution context', () => {
  it('is empty outside any boundary, and setting it there is a no-op', () => {
    expect(getAuditAttribution()).toBeNull()
    setAuditAttribution(UI_ATTRIBUTION)
    expect(getAuditAttribution()).toBeNull()
  })

  it('carries a boundary attribution across awaits for the whole async subtree', async () => {
    const seen = await runWithAuditAttribution(SYSTEM_ATTRIBUTION, async () => {
      await tick()
      return getAuditAttribution()
    })
    expect(seen).toEqual({ channel: 'system' })
    expect(getAuditAttribution()).toBeNull()
  })

  it('lets an inner boundary override the outer one for its subtree only', async () => {
    await runWithAuditAttribution(UI_ATTRIBUTION, async () => {
      const inner = await runWithAuditAttribution(
        { channel: 'assistant', clientName: 'Quinn', onBehalfOfPrincipalId: CREATOR },
        async () => {
          await tick()
          return getAuditAttribution()
        }
      )
      expect(inner).toMatchObject({ channel: 'assistant', onBehalfOfPrincipalId: CREATOR })
      expect(getAuditAttribution()).toEqual({ channel: 'ui' })
    })
  })

  it('fills an open slot from a callee, visible to the boundary after the callee returns', async () => {
    // The REST shape: the request boundary opens an empty slot, key auth runs
    // deep inside the route handler, and the boundary reads the result after.
    const afterHandler = await runWithAuditAttribution(null, async () => {
      expect(getAuditAttribution()).toBeNull()
      await (async () => {
        await tick()
        setAuditAttribution(
          apiKeyAttribution({ id: KEY_ID, name: 'Zapier', createdById: CREATOR }, 'api'),
          { type: 'service', role: 'admin', authMethod: 'api_key' }
        )
      })()
      return { attribution: getAuditAttribution(), actor: getAuditBoundaryActor() }
    })
    expect(afterHandler).toEqual({
      attribution: {
        channel: 'api',
        credentialKind: 'api_key',
        credentialId: KEY_ID,
        clientName: 'Zapier',
        onBehalfOfPrincipalId: CREATOR,
      },
      actor: { type: 'service', role: 'admin', authMethod: 'api_key' },
    })
  })

  it('keeps concurrent requests apart', async () => {
    const [a, b] = await Promise.all([
      runWithAuditAttribution(null, async () => {
        setAuditAttribution(
          apiKeyAttribution({ id: KEY_ID, name: 'A', createdById: CREATOR }, 'api')
        )
        await tick()
        return getAuditAttribution()?.clientName
      }),
      runWithAuditAttribution(null, async () => {
        await tick()
        setAuditAttribution(
          oauthClientAttribution({ clientId: 'client-b', clientName: 'B', principalId: CREATOR })
        )
        await tick()
        return getAuditAttribution()?.clientName
      }),
    ])
    expect([a, b]).toEqual(['A', 'B'])
  })
})

describe('attribution builders', () => {
  it('attributes an API key to its creator, on the channel that carried it', () => {
    expect(apiKeyAttribution({ id: KEY_ID, name: 'CI', createdById: CREATOR }, 'mcp')).toEqual({
      channel: 'mcp',
      credentialKind: 'api_key',
      credentialId: KEY_ID,
      clientName: 'CI',
      onBehalfOfPrincipalId: CREATOR,
    })
  })

  it('attributes an OAuth client to the user it acts for', () => {
    expect(
      oauthClientAttribution({
        clientId: 'abc123',
        clientName: 'Claude Desktop',
        principalId: CREATOR,
      })
    ).toEqual({
      channel: 'mcp',
      credentialKind: 'oauth_client',
      credentialId: 'abc123',
      clientName: 'Claude Desktop',
      onBehalfOfPrincipalId: CREATOR,
    })
  })

  it('strips control, newline and direction-override characters from a client name', () => {
    // An OAuth client names itself without signing in: a reversed or
    // multi-line name must not be able to pass for another client.
    const attribution = oauthClientAttribution({
      clientId: 'abc123',
      clientName: 'Claude\u202E pot\u202C Desktop\r\nInjected\u0007\u2066x\u2069\u200E\u200F\u061C',
      principalId: CREATOR,
    })
    expect(attribution.clientName).toBe('Claude pot Desktop Injectedx')
    expect(
      oauthClientAttribution({
        clientId: 'abc',
        clientName: '\u202E\n\u0000 ',
        principalId: CREATOR,
      }).clientName
    ).toBeNull()
    expect(
      apiKeyAttribution({ id: KEY_ID, name: 'CI\tkey\u202D', createdById: CREATOR }, 'api')
        .clientName
    ).toBe('CI key')
  })

  it('caps a self-registered client name before it reaches a row', () => {
    const attribution = oauthClientAttribution({
      clientId: 'abc123',
      clientName: 'x'.repeat(5000),
      principalId: CREATOR,
    })
    expect(attribution.clientName).toHaveLength(200)
  })
})

describe('auditAttributionColumns', () => {
  it('maps the active attribution onto the audit_log columns', async () => {
    const columns = await runWithAuditAttribution(
      oauthClientAttribution({ clientId: 'abc123', clientName: 'Cursor', principalId: CREATOR }),
      async () => auditAttributionColumns()
    )
    expect(columns).toEqual({
      channel: 'mcp',
      credentialKind: 'oauth_client',
      credentialId: 'abc123',
      clientName: 'Cursor',
      onBehalfOfPrincipalId: CREATOR,
    })
  })

  it('is all null with no attribution', () => {
    expect(auditAttributionColumns()).toEqual({
      channel: null,
      credentialKind: null,
      credentialId: null,
      clientName: null,
      onBehalfOfPrincipalId: null,
    })
  })
})
