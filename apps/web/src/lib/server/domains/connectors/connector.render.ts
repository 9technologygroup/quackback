/**
 * Connector template rendering. Pure and dependency-free, mirroring
 * macro.render.ts's shape: a single `{token}` placeholder syntax (no fallback
 * syntax), resolved only against the values the caller supplies. A token
 * absent from `values` — an undeclared input, a typo, a builtin the caller
 * didn't pass — renders as the empty string rather than leaking the raw
 * placeholder or throwing, so a malformed template degrades instead of
 * breaking the tool call.
 *
 * Dots are allowed in the token body so builtins like `{customer.email}` work
 * alongside declared input names like `{ticket_id}`.
 */

const TOKEN_PATTERN = /\{([\w.]+)\}/g

export type ConnectorTemplateEncoding = 'uri' | 'json' | 'raw'

export interface RenderTemplateOptions {
  /**
   * How a resolved value is escaped for the position it's rendered into:
   * - 'uri': URI-component-encoded, for values interpolated into a URL.
   * - 'json': JSON-string-escaped (no surrounding quotes — the template
   *   supplies those), for values interpolated into a JSON request body.
   * - 'raw': inserted verbatim, for header values.
   */
  encode: ConnectorTemplateEncoding
}

/** Escape a string for embedding inside a JSON string literal, without the
 *  surrounding quotes the template already provides. */
function jsonEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

function encodeValue(value: string, encoding: ConnectorTemplateEncoding): string {
  switch (encoding) {
    case 'uri':
      return encodeURIComponent(value)
    case 'json':
      return jsonEscape(value)
    case 'raw':
      return value
  }
}

/**
 * Interpolate `{token}` placeholders in `template` against `values`. A token
 * not present as a key in `values` — the only allowlist there is — renders
 * as ''.
 */
export function renderTemplate(
  template: string,
  values: Record<string, string | number | boolean>,
  opts: RenderTemplateOptions
): string {
  return template.replace(TOKEN_PATTERN, (_match, token: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, token)) return ''
    const value = values[token]
    if (value === undefined || value === null) return ''
    return encodeValue(String(value), opts.encode)
  })
}
