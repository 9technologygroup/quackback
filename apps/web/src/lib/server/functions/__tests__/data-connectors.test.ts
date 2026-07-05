/**
 * Data connector admin server fns: permission + feature-flag gate, boundary
 * validation, and pass-through to the domain layer. createServerFn is
 * stubbed to a directly-callable fn (mirrors assistant-settings.test.ts) so
 * the real zod validator runs on each call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PERMISSIONS } from '@/lib/shared/permissions'

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    let _schema: { parse: (v: unknown) => unknown } | null = null
    let _handler: ((args: { data: unknown }) => Promise<unknown>) | null = null
    const fn = async (args?: { data: unknown }) => {
      if (!_handler) throw new Error('handler not registered')
      return _handler({ data: _schema ? _schema.parse(args?.data) : args?.data })
    }
    fn.validator = (schema: { parse: (v: unknown) => unknown }) => {
      _schema = schema
      return fn
    }
    fn.handler = (h: (args: { data: unknown }) => Promise<unknown>) => {
      _handler = h
      return fn
    }
    return fn
  },
}))

const hoisted = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  isFeatureEnabled: vi.fn(),
  listConnectors: vi.fn(),
  getConnector: vi.fn(),
  createConnector: vi.fn(),
  updateConnector: vi.fn(),
  deleteConnector: vi.fn(),
  testConnector: vi.fn(),
}))

vi.mock('@/lib/server/functions/auth-helpers', () => ({ requireAuth: hoisted.requireAuth }))
vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  isFeatureEnabled: hoisted.isFeatureEnabled,
}))
vi.mock('@/lib/server/domains/connectors/connector.service', () => ({
  listConnectors: hoisted.listConnectors,
  getConnector: hoisted.getConnector,
  createConnector: hoisted.createConnector,
  updateConnector: hoisted.updateConnector,
  deleteConnector: hoisted.deleteConnector,
}))
vi.mock('@/lib/server/domains/connectors/connector.execute', () => ({
  testConnector: hoisted.testConnector,
}))

import {
  fetchDataConnectorsFn,
  fetchDataConnectorFn,
  createDataConnectorFn,
  updateDataConnectorFn,
  deleteDataConnectorFn,
  testDataConnectorFn,
} from '../data-connectors'

const VALID_CREATE = {
  name: 'Get User',
  description: 'Look up a user by id.',
  method: 'GET' as const,
  urlTemplate: 'https://api.example.com/users/{id}',
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireAuth.mockResolvedValue({ principal: { id: 'principal_admin' } })
  hoisted.isFeatureEnabled.mockResolvedValue(true)
})

describe('access gate', () => {
  it('every fn requires connector.manage', async () => {
    hoisted.listConnectors.mockResolvedValue([])
    await fetchDataConnectorsFn()
    expect(hoisted.requireAuth).toHaveBeenLastCalledWith({ permission: PERMISSIONS.CONNECTOR_MANAGE })

    hoisted.createConnector.mockResolvedValue({ id: 'data_connector_1' })
    await createDataConnectorFn({ data: VALID_CREATE })
    expect(hoisted.requireAuth).toHaveBeenLastCalledWith({ permission: PERMISSIONS.CONNECTOR_MANAGE })
  })

  it('rejects when the dataConnectors flag is off, without calling the domain layer', async () => {
    hoisted.isFeatureEnabled.mockResolvedValue(false)
    await expect(fetchDataConnectorsFn()).rejects.toThrow(/not enabled/)
    expect(hoisted.listConnectors).not.toHaveBeenCalled()
  })

  it('propagates an auth rejection without checking the flag', async () => {
    hoisted.requireAuth.mockRejectedValue(new Error('Access denied'))
    await expect(fetchDataConnectorsFn()).rejects.toThrow('Access denied')
    expect(hoisted.isFeatureEnabled).not.toHaveBeenCalled()
  })
})

describe('fetchDataConnectorsFn', () => {
  it('returns the connector list', async () => {
    hoisted.listConnectors.mockResolvedValue([{ id: 'data_connector_1' }])
    expect(await fetchDataConnectorsFn()).toEqual({ connectors: [{ id: 'data_connector_1' }] })
  })
})

describe('fetchDataConnectorFn', () => {
  it('passes the id through', async () => {
    hoisted.getConnector.mockResolvedValue({ id: 'data_connector_1' })
    const result = await fetchDataConnectorFn({ data: { id: 'data_connector_1' } })
    expect(hoisted.getConnector).toHaveBeenCalledWith('data_connector_1')
    expect(result).toEqual({ id: 'data_connector_1' })
  })
})

describe('createDataConnectorFn', () => {
  it('rejects an invalid method at the boundary before reaching the domain layer', async () => {
    await expect(
      createDataConnectorFn({ data: { ...VALID_CREATE, method: 'PUT' } as never })
    ).rejects.toThrow()
    expect(hoisted.createConnector).not.toHaveBeenCalled()
  })

  it('rejects a non-HTTPS-shaped payload missing required fields', async () => {
    await expect(createDataConnectorFn({ data: { name: 'x' } as never })).rejects.toThrow()
    expect(hoisted.createConnector).not.toHaveBeenCalled()
  })

  it('creates with the caller as createdById', async () => {
    hoisted.createConnector.mockResolvedValue({ id: 'data_connector_1', ...VALID_CREATE })
    const result = await createDataConnectorFn({ data: VALID_CREATE })
    expect(hoisted.createConnector).toHaveBeenCalledWith(VALID_CREATE, 'principal_admin')
    expect(result).toMatchObject({ id: 'data_connector_1' })
  })

  it('rejects a header auth type missing headerName at the boundary', async () => {
    await expect(
      createDataConnectorFn({
        data: { ...VALID_CREATE, auth: { type: 'header' } } as never,
      })
    ).rejects.toThrow()
    expect(hoisted.createConnector).not.toHaveBeenCalled()
  })
})

describe('updateDataConnectorFn', () => {
  it('splits id from the patch payload', async () => {
    hoisted.updateConnector.mockResolvedValue({ id: 'data_connector_1', name: 'New Name' })
    await updateDataConnectorFn({ data: { id: 'data_connector_1', name: 'New Name' } })
    expect(hoisted.updateConnector).toHaveBeenCalledWith('data_connector_1', { name: 'New Name' })
  })
})

describe('deleteDataConnectorFn', () => {
  it('deletes and returns the id', async () => {
    hoisted.deleteConnector.mockResolvedValue(undefined)
    const result = await deleteDataConnectorFn({ data: { id: 'data_connector_1' } })
    expect(hoisted.deleteConnector).toHaveBeenCalledWith('data_connector_1')
    expect(result).toEqual({ id: 'data_connector_1' })
  })
})

describe('testDataConnectorFn', () => {
  it('defaults sampleValues to an empty object', async () => {
    hoisted.testConnector.mockResolvedValue({ ok: true, status: 200, data: {} })
    await testDataConnectorFn({ data: { id: 'data_connector_1' } })
    expect(hoisted.testConnector).toHaveBeenCalledWith('data_connector_1', {})
  })

  it('passes sampleValues through', async () => {
    hoisted.testConnector.mockResolvedValue({ ok: true, status: 200, data: {} })
    await testDataConnectorFn({ data: { id: 'data_connector_1', sampleValues: { id: '42' } } })
    expect(hoisted.testConnector).toHaveBeenCalledWith('data_connector_1', { id: '42' })
  })
})
