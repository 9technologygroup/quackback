/**
 * Tests for the handoff comment posted on an imported GitHub issue.
 */

import { describe, it, expect } from 'vitest'
import { buildHandoffMessage } from '../import-handoff'
import { QUACKBACK_MARKER } from '../message'

const URL = 'https://feedback.example.com/b/feature-requests/posts/post_abc123'

describe('buildHandoffMessage', () => {
  it('substitutes the post url into the default message', () => {
    const message = buildHandoffMessage(URL)
    expect(message).toContain(URL)
    expect(message).not.toContain('{{url}}')
  })

  it('tells the reader the issue is being closed', () => {
    expect(buildHandoffMessage(URL).toLowerCase()).toContain('closing this issue')
  })

  it('substitutes every occurrence in a custom template', () => {
    const message = buildHandoffMessage(URL, 'Moved to {{url}} — please follow {{url}} instead.')
    expect(message).toContain(`Moved to ${URL} — please follow ${URL} instead.`)
    expect(message).not.toContain('{{url}}')
  })

  it('appends the marker even when substitution produced only bare links', () => {
    // A bare {{url}} expands to a plain URL, which is not the marker — the
    // inbound handler would not recognise the comment as our own write.
    const message = buildHandoffMessage(URL, 'Moved to {{url}}')
    expect(message).toContain(QUACKBACK_MARKER)
  })

  it('does not append a second link when the template already carries the marker', () => {
    const message = buildHandoffMessage(URL, `Moved. [View in Quackback](${URL})`)
    expect(message).toBe(`Moved. [View in Quackback](${URL})`)
    expect(message.match(/View in Quackback/g)).toHaveLength(1)
  })

  it('appends the link when a custom template forgets the placeholder', () => {
    // Without the trailing link the comment has no marker, and the inbound
    // handler would mirror our own comment back onto the post.
    const message = buildHandoffMessage(URL, 'Tracked elsewhere now.')
    expect(message).toContain('Tracked elsewhere now.')
    expect(message).toContain(URL)
    expect(message).toContain(QUACKBACK_MARKER)
  })

  it('falls back to the default for a blank or whitespace template', () => {
    const fallback = buildHandoffMessage(URL)
    expect(buildHandoffMessage(URL, '')).toBe(fallback)
    expect(buildHandoffMessage(URL, '   ')).toBe(fallback)
  })

  it('always carries the echo-guard marker', () => {
    expect(buildHandoffMessage(URL)).toContain(QUACKBACK_MARKER)
    expect(buildHandoffMessage(URL, 'Moved to {{url}}')).toContain(QUACKBACK_MARKER)
  })
})
