/**
 * Companies-directory filter encoding.
 *
 * The Companies tab stores its filters in one URL param (`companyAttrs`) using
 * the same "key:op:value" comma-joined format as the People tab's customAttrs.
 * Reserved keys route to standard company columns; everything else is a
 * custom-attribute predicate over the jsonb blob. Client-safe (no DB imports).
 */

export interface CompanyMrrFilter {
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'
  value: number
}

export interface CompanyFilterParts {
  plan?: string
  mrr?: CompanyMrrFilter
  attrs?: { key: string; op: string; value: string }[]
}

const MRR_OPS = new Set(['gt', 'gte', 'lt', 'lte', 'eq'])

/** Keys that map to standard company columns rather than custom attributes. */
export const COMPANY_RESERVED_FILTER_KEYS = new Set(['plan', 'mrr'])

/** Decode the `companyAttrs` URL param into the server filter shape. */
export function parseCompanyFilterParts(encoded?: string): CompanyFilterParts {
  const parts: CompanyFilterParts = {}
  if (!encoded) return parts

  const attrs: { key: string; op: string; value: string }[] = []
  for (const part of encoded.split(',').filter(Boolean)) {
    const [key, op, ...rest] = part.split(':')
    if (!key || !op) continue
    const value = rest.join(':')
    if (key === 'plan') {
      parts.plan = value
    } else if (key === 'mrr') {
      const num = Number(value)
      if (MRR_OPS.has(op) && value !== '' && !Number.isNaN(num)) {
        parts.mrr = { op: op as CompanyMrrFilter['op'], value: num }
      }
    } else {
      attrs.push({ key, op, value })
    }
  }
  if (attrs.length > 0) parts.attrs = attrs
  return parts
}

/** Build the /api/export/companies URL for the current filtered view. */
export function buildCompaniesExportUrl(search: string | undefined, encoded?: string): string {
  const parts = parseCompanyFilterParts(encoded)
  const params = new URLSearchParams()
  if (search?.trim()) params.set('search', search.trim())
  if (parts.plan) params.set('plan', parts.plan)
  if (parts.mrr) params.set('mrr', `${parts.mrr.op}:${parts.mrr.value}`)
  if (parts.attrs && parts.attrs.length > 0) {
    params.set('attrs', parts.attrs.map((a) => `${a.key}:${a.op}:${a.value}`).join(','))
  }
  const qs = params.toString()
  return qs ? `/api/export/companies?${qs}` : '/api/export/companies'
}
