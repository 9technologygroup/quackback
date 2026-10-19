import { describe, expect, it } from 'vitest'
import {
  connectorToolName,
  parseConnectorToolName,
  resolveToolPolicy,
  slugifyConnectorName,
  stableToolHash,
  toolGroupFromAnnotations,
  DEFAULT_CONNECTOR_TOOL_POLICIES,
  connectorCreateInputSchema,
  connectorAssignmentsSchema,
} from '../connectors'

describe('slugifyConnectorName', () => {
  it('lowercases, hyphenates, and caps at 20 chars', () => {
    expect(slugifyConnectorName('Acme Billing')).toBe('acme-billing')
    expect(slugifyConnectorName('  Hello___World  ')).toBe('hello-world')
    expect(slugifyConnectorName('A'.repeat(40))).toHaveLength(20)
  })

  it('falls back when the name has no slug characters', () => {
    expect(slugifyConnectorName('!!!')).toBe('connector')
  })
})

describe('connectorToolName', () => {
  it('uses connector_<slug>__<tool>', () => {
    expect(connectorToolName('acme', 'get_invoice')).toBe('connector_acme__get_invoice')
  })

  it('caps at 64 chars with a stable hash suffix', () => {
    const name = connectorToolName('verylongslugnamexx', 'a'.repeat(80))
    expect(name.length).toBeLessThanOrEqual(64)
    expect(name.startsWith('connector_verylongslugnamexx__')).toBe(true)
    expect(name.endsWith(stableToolHash('a'.repeat(80)))).toBe(true)
    expect(parseConnectorToolName(name)?.slug).toBe('verylongslugnamexx')
  })
})

describe('resolveToolPolicy', () => {
  it('uses group defaults until a per-tool override is set', () => {
    const policies = {
      groupDefaults: { read: 'always' as const, write: 'approval' as const },
      tools: { issue_refund: 'never' as const },
    }
    expect(resolveToolPolicy(policies, 'get_invoice', 'read')).toBe('always')
    expect(resolveToolPolicy(policies, 'extend_trial', 'write')).toBe('approval')
    expect(resolveToolPolicy(policies, 'issue_refund', 'write')).toBe('never')
  })

  it('treats missing readOnlyHint as write', () => {
    expect(toolGroupFromAnnotations({})).toBe('write')
    expect(toolGroupFromAnnotations({ readOnlyHint: true })).toBe('read')
    expect(DEFAULT_CONNECTOR_TOOL_POLICIES.groupDefaults.write).toBe('approval')
  })
})

describe('connector assignments defaults', () => {
  const base = { name: 'CRM', url: 'https://example.com/mcp' }

  it('starts new connectors available to teammates only', () => {
    const parsed = connectorCreateInputSchema.parse(base)
    expect(parsed.assignments).toEqual({ agent: false, copilot: true })
  })

  it('respects explicit assignments', () => {
    const parsed = connectorCreateInputSchema.parse({
      ...base,
      assignments: { agent: true, copilot: false },
    })
    expect(parsed.assignments).toEqual({ agent: true, copilot: false })
  })

  it('keeps stored assignments unchanged when parsing', () => {
    expect(connectorAssignmentsSchema.parse({ agent: true, copilot: true })).toEqual({
      agent: true,
      copilot: true,
    })
  })
})
