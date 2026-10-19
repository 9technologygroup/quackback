// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isDeviceCodeRequest, prepareDeviceCodeRequest } from '../device-request'

const RESOURCE = 'https://feedback.example.com/api/mcp'
const URL_ = 'https://feedback.example.com/api/auth/device/code'

const json = (body: unknown) =>
  new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const form = (params: Record<string, string>) =>
  new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })

describe('prepareDeviceCodeRequest', () => {
  it('recognises only the device code request', () => {
    expect(isDeviceCodeRequest(json({}))).toBe(true)
    expect(isDeviceCodeRequest(new Request(URL_))).toBe(false)
    expect(
      isDeviceCodeRequest(new Request(`${URL_.replace('/code', '/approve')}`, { method: 'POST' }))
    ).toBe(false)
  })

  it('defaults the MCP resource and drops user_id from a JSON body', async () => {
    const out = await prepareDeviceCodeRequest(
      json({ client_id: 'c', scope: 'openid', user_id: 'user_victim' }),
      RESOURCE
    )
    expect(await out.json()).toEqual({ client_id: 'c', scope: 'openid', resource: RESOURCE })
  })

  it('defaults the MCP resource and drops user_id from a form body', async () => {
    const out = await prepareDeviceCodeRequest(
      form({ client_id: 'c', user_id: 'user_victim' }),
      RESOURCE
    )
    const params = new URLSearchParams(await out.text())
    expect(params.get('resource')).toBe(RESOURCE)
    expect(params.has('user_id')).toBe(false)
    expect(params.get('client_id')).toBe('c')
  })

  it('keeps a resource the client sent', async () => {
    const out = await prepareDeviceCodeRequest(
      json({ client_id: 'c', resource: 'https://other.example/api/mcp' }),
      RESOURCE
    )
    expect(((await out.json()) as { resource: string }).resource).toBe(
      'https://other.example/api/mcp'
    )
  })

  it('leaves other requests untouched', async () => {
    const req = new Request('https://feedback.example.com/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(await prepareDeviceCodeRequest(req, RESOURCE)).toBe(req)
  })
})
