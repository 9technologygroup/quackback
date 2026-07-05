/**
 * Data Connector v0 domain types. A connector is an admin-defined external
 * API call the assistant can invoke as a tool; see connector.toolspec.ts for
 * how a row becomes a model-facing tool.
 */
import type { DataConnectorId, PrincipalId } from '@quackback/ids'
import type { JsonValue } from '@/lib/shared/json'
import type {
  ConnectorMethod,
  ConnectorStatus,
  ConnectorAuthType,
  ConnectorAuthConfig,
  ConnectorInputType,
  ConnectorInputField,
  ConnectorHeader,
} from '@/lib/server/db'

export type {
  ConnectorMethod,
  ConnectorStatus,
  ConnectorAuthType,
  ConnectorAuthConfig,
  ConnectorInputType,
  ConnectorInputField,
  ConnectorHeader,
}

/** Read-facing shape: never carries the secret, only whether one is configured. */
export interface DataConnector {
  id: DataConnectorId
  name: string
  slug: string
  description: string
  method: ConnectorMethod
  urlTemplate: string
  headers: ConnectorHeader[]
  auth: ConnectorAuthConfig
  hasSecret: boolean
  inputs: ConnectorInputField[]
  bodyTemplate: string | null
  /** Truncated sample body from the last successful test call — always JSON-shaped
   *  (parsed JSON, a truncated string, or a `{truncated, preview}` marker). */
  exampleResponse: JsonValue | null
  responsePaths: string[] | null
  timeoutMs: number
  enabled: boolean
  status: ConnectorStatus
  failureCount: number
  lastError: string | null
  lastTestedAt: Date | null
  createdById: PrincipalId | null
  createdAt: Date
  updatedAt: Date
}

export interface CreateConnectorInput {
  name: string
  description: string
  method: ConnectorMethod
  urlTemplate: string
  headers?: ConnectorHeader[]
  auth?: ConnectorAuthConfig
  /** Plaintext; encrypted before storage. Omit to leave auth secretless. */
  secret?: string
  inputs?: ConnectorInputField[]
  bodyTemplate?: string
  timeoutMs?: number
  enabled?: boolean
}

export interface UpdateConnectorInput {
  name?: string
  description?: string
  method?: ConnectorMethod
  urlTemplate?: string
  headers?: ConnectorHeader[]
  auth?: ConnectorAuthConfig
  /** A new plaintext secret to encrypt and store, replacing any existing one. */
  secret?: string
  /** Explicitly remove a previously configured secret without providing a new one. */
  clearSecret?: boolean
  inputs?: ConnectorInputField[]
  bodyTemplate?: string | null
  timeoutMs?: number
  enabled?: boolean
  status?: ConnectorStatus
}

/** Values a connector call resolves `{token}` placeholders against — declared
 *  inputs plus the builtins in connector.render.ts. */
export type ConnectorValues = Record<string, string | number | boolean>

/** Context the tool-execution seam threads in for the builtin tokens. */
export interface ConnectorRuntimeContext {
  customerEmail?: string | null
  customerName?: string | null
  conversationId?: string | null
}

/** Outcome of one connector call — network execution never throws; every path
 *  is a discriminated result so callers (the tool, testConnector) can render
 *  a graceful note instead of an unhandled rejection. */
export type ConnectorExecutionResult =
  | { ok: true; status: number; data: JsonValue }
  | { ok: false; reason: 'rate_limited' }
  | { ok: false; reason: 'host_not_allowed'; message: string }
  | { ok: false; reason: 'http_error'; status: number; message: string }
  | { ok: false; reason: 'network_error'; message: string }
