import { describe, it, expect } from 'vitest'
import { stripCitationMarkers, formatConversationSummaryNote } from '../copilot-format'

describe('stripCitationMarkers', () => {
  it('removes a single inline marker without leaving a double space', () => {
    expect(stripCitationMarkers('The refund window is 30 days [1].')).toBe(
      'The refund window is 30 days.'
    )
  })

  it('removes multiple markers anywhere in the text', () => {
    expect(stripCitationMarkers('First point [1]. Second point [2].')).toBe(
      'First point. Second point.'
    )
  })

  it('removes adjacent markers with no leftover spacing', () => {
    expect(stripCitationMarkers('Confirmed by two sources [1] [2].')).toBe(
      'Confirmed by two sources.'
    )
  })

  it('removes a marker glued to the preceding word with no space', () => {
    expect(stripCitationMarkers('See settings[1] for details.')).toBe('See settings for details.')
  })

  it('removes a marker at the very start of the text', () => {
    expect(stripCitationMarkers('[1] Refunds are processed within 30 days.')).toBe(
      'Refunds are processed within 30 days.'
    )
  })

  it('leaves text with no markers unchanged (aside from trimming)', () => {
    expect(stripCitationMarkers('No citations here.')).toBe('No citations here.')
  })

  it('preserves newlines and list structure', () => {
    const input = 'Steps to resolve [1]:\n- Reset the password [2]\n- Confirm the email [3]'
    expect(stripCitationMarkers(input)).toBe(
      'Steps to resolve:\n- Reset the password\n- Confirm the email'
    )
  })

  it('trims surrounding whitespace', () => {
    expect(stripCitationMarkers('  padded text [1]  ')).toBe('padded text')
  })
})

describe('formatConversationSummaryNote', () => {
  it('formats a Question line and a Summary bullet list', () => {
    const text = formatConversationSummaryNote('Duplicate March invoice charge', [
      'Customer was charged twice for their March invoice.',
      'Refunded the duplicate charge.',
    ])
    expect(text).toBe(
      'Question\nDuplicate March invoice charge\n\nSummary\n- Customer was charged twice for their March invoice.\n- Refunded the duplicate charge.'
    )
  })

  it('formats a single bullet with no trailing separator', () => {
    const text = formatConversationSummaryNote('Refund window', ['Explained the 30-day window.'])
    expect(text).toBe('Question\nRefund window\n\nSummary\n- Explained the 30-day window.')
  })

  it('renders an empty bullet list as a bare Summary heading', () => {
    const text = formatConversationSummaryNote('Unresolved billing question', [])
    expect(text).toBe('Question\nUnresolved billing question\n\nSummary\n')
  })
})
