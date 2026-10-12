/**
 * Canonical JSON and its digest: the one fingerprint of a value.
 *
 * Tool arguments, effective snapshots, connector contracts and integration
 * sync identities are all fingerprinted through this, so two digests of the
 * same thing can never disagree because two copies of the walk drifted.
 */
import { createHash } from 'node:crypto'

/**
 * How deep a value may be before this refuses to fingerprint it.
 *
 * The same ceiling the connector schema walk uses, and for the same reason:
 * past it, a structure is either pathological or cyclic, and a cycle would
 * otherwise end this function in a stack overflow rather than an answer.
 */
const MAX_CANONICAL_JSON_DEPTH = 32

/**
 * JSON.stringify with object keys sorted at every depth, so two equivalent
 * values hash the same.
 *
 * A disagreement between two digests reads as "the contract changed" or "the
 * request changed" and stops a real action, which is why there is one walk.
 *
 * An `undefined` property is left out, exactly as `JSON.stringify` leaves it
 * out, so a value that survived a JSON round trip hashes the same as the one
 * that went in.
 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    throw new RangeError(
      `canonicalJson: value exceeds the maximum depth of ${MAX_CANONICAL_JSON_DEPTH}`
    )
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries: string[] = []
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const nested = (value as Record<string, unknown>)[key]
      if (nested === undefined) continue
      entries.push(`${JSON.stringify(key)}:${canonicalJson(nested, depth + 1)}`)
    }
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** The canonical digest of a value. Stable across key order and across processes. */
export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
