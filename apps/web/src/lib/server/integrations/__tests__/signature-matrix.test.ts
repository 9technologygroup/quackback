import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { githubInboundHandler } from '../github/inbound'
import { jiraInboundHandler } from '../jira/inbound'
import { asanaInboundHandler } from '../asana/inbound'
import { gitlabInboundHandler } from '../gitlab/inbound'
import { trelloInboundHandler } from '../trello/inbound'
import { clickupInboundHandler } from '../clickup/inbound'
import { azureDevOpsInboundHandler } from '../azure-devops/inbound'

const body = JSON.stringify({ event: 'test' })
const secret = 'webhook-secret'
const url = 'https://feedback.example.com/api/integrations/test/webhook'

const cases = [
  {
    name: 'GitHub',
    handler: githubInboundHandler,
    header: 'X-Hub-Signature-256',
    valid: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  },
  {
    name: 'Jira',
    handler: jiraInboundHandler,
    header: 'X-Hub-Signature',
    valid: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  },
  {
    name: 'Asana',
    handler: asanaInboundHandler,
    header: 'X-Hook-Signature',
    valid: createHmac('sha256', secret).update(body).digest('hex'),
  },
  { name: 'GitLab', handler: gitlabInboundHandler, header: 'X-Gitlab-Token', valid: secret },
  {
    name: 'Trello',
    handler: trelloInboundHandler,
    header: 'x-trello-webhook',
    valid: createHmac('sha1', secret)
      .update(body + url)
      .digest('base64'),
  },
  {
    name: 'ClickUp',
    handler: clickupInboundHandler,
    header: 'X-Signature',
    valid: createHmac('sha256', secret).update(body).digest('hex'),
  },
  {
    name: 'Azure DevOps',
    handler: azureDevOpsInboundHandler,
    header: 'Authorization',
    valid: `Basic ${Buffer.from(`quackback:${secret}`).toString('base64')}`,
  },
] as const

describe.each(cases)('$name inbound signature', ({ handler, header, valid }) => {
  const verify = handler.verifySignature!

  it('accepts a valid signature', async () => {
    expect(await verify(new Request(url, { headers: { [header]: valid } }), body, secret)).toBe(
      true
    )
  })

  it.each([
    ['missing', undefined],
    ['tampered', valid.slice(0, -1) + (valid.endsWith('a') ? 'b' : 'a')],
    ['malformed/length mismatch', 'x'],
  ])('rejects %s signatures without throwing', async (_label, value) => {
    const headers = value === undefined ? undefined : { [header]: value }
    const result = await verify(new Request(url, { headers }), body, secret)
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
  })
})
