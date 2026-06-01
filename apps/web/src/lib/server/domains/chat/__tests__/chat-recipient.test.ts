import { describe, it, expect } from 'vitest'
import { resolveReplyRecipient } from '../chat.recipient'

describe('resolveReplyRecipient', () => {
  it('prefers an identified visitor account email', () => {
    expect(resolveReplyRecipient({ type: 'user', email: 'a@b.com' }, 'captured@x.com')).toBe(
      'a@b.com'
    )
  })

  it('falls back to the captured pre-chat email for an anonymous visitor', () => {
    expect(resolveReplyRecipient({ type: 'anonymous', email: null }, 'captured@x.com')).toBe(
      'captured@x.com'
    )
  })

  it('falls back to captured when an identified account has no email on record', () => {
    expect(resolveReplyRecipient({ type: 'user', email: null }, 'captured@x.com')).toBe(
      'captured@x.com'
    )
  })

  it('returns null when there is no reachable address', () => {
    expect(resolveReplyRecipient({ type: 'anonymous', email: null }, null)).toBeNull()
    expect(resolveReplyRecipient(undefined, undefined)).toBeNull()
  })
})
