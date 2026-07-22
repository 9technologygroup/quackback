/**
 * Tests for GitHub inbound webhook handler.
 */

import { describe, it, expect } from 'vitest'
import { createHmac } from 'crypto'
import { githubInboundHandler } from '../inbound'

function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/webhook', { headers })
}

function issuePayload(
  action: string,
  issue: Record<string, unknown> = {},
  repoFullName = 'acme/app'
) {
  return JSON.stringify({
    action,
    repository: { full_name: repoFullName },
    issue: {
      number: 142,
      title: 'Something is broken',
      body: 'Steps to reproduce…',
      html_url: 'https://github.com/acme/app/issues/142',
      user: { id: 999, login: 'octocat', name: 'The Octocat' },
      ...issue,
    },
  })
}

describe('githubInboundHandler.verifySignature', () => {
  const secret = 'webhook-secret'
  const body = '{"test": true}'

  it('returns true for a valid signature', async () => {
    const req = makeRequest({ 'X-Hub-Signature-256': sign(body, secret) })
    expect(await githubInboundHandler.verifySignature(req, body, secret)).toBe(true)
  })

  it('returns 401 when the signature header is missing', async () => {
    const result = await githubInboundHandler.verifySignature(makeRequest(), body, secret)
    expect((result as Response).status).toBe(401)
  })

  it('returns 401 for an invalid signature', async () => {
    const req = makeRequest({ 'X-Hub-Signature-256': sign(body, 'wrong-secret') })
    const result = await githubInboundHandler.verifySignature(req, body, secret)
    expect((result as Response).status).toBe(401)
  })
})

describe('githubInboundHandler.parseCreatePost', () => {
  it('produces a create intent for an opened issue', async () => {
    const intent = await githubInboundHandler.parseCreatePost!(issuePayload('opened'), {}, {})
    expect(intent).toEqual({
      externalId: '142',
      title: 'Something is broken',
      body: 'Steps to reproduce…',
      externalUrl: 'https://github.com/acme/app/issues/142',
      reporter: { githubId: 999, login: 'octocat', name: 'The Octocat' },
      eventType: 'issues.opened',
    })
  })

  it('ignores non-opened actions', async () => {
    expect(await githubInboundHandler.parseCreatePost!(issuePayload('closed'), {}, {})).toBeNull()
    expect(await githubInboundHandler.parseCreatePost!(issuePayload('edited'), {}, {})).toBeNull()
  })

  it('skips pull requests delivered on the issues event', async () => {
    const body = issuePayload('opened', { pull_request: { url: 'https://api…/pulls/1' } })
    expect(await githubInboundHandler.parseCreatePost!(body, {}, {})).toBeNull()
  })

  it('falls back to a title when the issue title is empty', async () => {
    const body = issuePayload('opened', { title: '' })
    const intent = await githubInboundHandler.parseCreatePost!(body, {}, {})
    expect(intent?.title).toBe('Issue #142')
  })

  it('skips issues Quackback itself created (echo prevention)', async () => {
    const body = issuePayload('opened', {
      body: 'Some feedback\n\n---\n\n[View in Quackback](https://feedback.acme.com/p/123)',
    })
    expect(await githubInboundHandler.parseCreatePost!(body, {}, {})).toBeNull()
  })

  it('rejects issues from a repo other than the configured one', async () => {
    const body = issuePayload('opened', {}, 'someone-else/other-repo')
    expect(
      await githubInboundHandler.parseCreatePost!(body, { channelId: 'acme/app' }, {})
    ).toBeNull()
  })

  it('accepts issues from the configured repo', async () => {
    const body = issuePayload('opened', {}, 'acme/app')
    const intent = await githubInboundHandler.parseCreatePost!(body, { channelId: 'acme/app' }, {})
    expect(intent?.externalId).toBe('142')
  })

  it('omits the reporter when the user has no login', async () => {
    const body = issuePayload('opened', { user: { id: 5 } })
    const intent = await githubInboundHandler.parseCreatePost!(body, {}, {})
    expect(intent?.reporter).toBeUndefined()
  })
})

describe('githubInboundHandler.parseStatusChange', () => {
  it('maps closed → Closed', async () => {
    const result = await githubInboundHandler.parseStatusChange(issuePayload('closed'), {}, {})
    expect(result).toMatchObject({ externalId: '142', externalStatus: 'Closed' })
  })

  it('maps reopened → Open', async () => {
    const result = await githubInboundHandler.parseStatusChange(issuePayload('reopened'), {}, {})
    expect(result).toMatchObject({ externalId: '142', externalStatus: 'Open' })
  })

  it('ignores opened (handled by parseCreatePost instead)', async () => {
    expect(await githubInboundHandler.parseStatusChange(issuePayload('opened'), {}, {})).toBeNull()
  })
})
