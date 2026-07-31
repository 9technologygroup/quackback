/**
 * Tests for GitHub issue and comment body formatting.
 */

import { describe, it, expect } from 'vitest'
import { buildPromotedIssueBody, QUACKBACK_MARKER } from '../message'

const base = {
  title: 'Phased patch rollouts',
  content: '<p>Roll patches out to a canary group first.</p>',
  voteCount: 47,
  boardSlug: 'feature-requests',
  postId: 'post_abc123',
  status: 'Planned',
  rootUrl: 'https://feedback.example.com',
}

describe('buildPromotedIssueBody', () => {
  it('keeps the post title as the issue title', () => {
    expect(buildPromotedIssueBody(base).title).toBe('Phased patch rollouts')
  })

  it('leads with the vote count, since that is why it was scheduled', () => {
    expect(buildPromotedIssueBody(base).body).toContain('**47 votes**')
  })

  it('singularises a lone vote', () => {
    const { body } = buildPromotedIssueBody({ ...base, voteCount: 1 })
    expect(body).toContain('**1 vote**')
    expect(body).not.toContain('1 votes')
  })

  it('handles a post with no votes', () => {
    expect(buildPromotedIssueBody({ ...base, voteCount: 0 }).body).toContain('**0 votes**')
  })

  it('names the status that triggered the promotion', () => {
    expect(buildPromotedIssueBody(base).body).toContain('**Planned**')
  })

  it('strips HTML from the post content', () => {
    const { body } = buildPromotedIssueBody(base)
    expect(body).toContain('Roll patches out to a canary group first.')
    expect(body).not.toContain('<p>')
  })

  it('links back to the post', () => {
    expect(buildPromotedIssueBody(base).body).toContain(
      'https://feedback.example.com/b/feature-requests/posts/post_abc123'
    )
  })

  it('carries the echo-guard marker so the issue is recognised as our own write', () => {
    // Without this the inbound handler would import the issue we just created
    // back into Quackback as a second post.
    expect(buildPromotedIssueBody(base).body).toContain(QUACKBACK_MARKER)
  })

  it('truncates very long content', () => {
    const { body } = buildPromotedIssueBody({ ...base, content: 'x'.repeat(5000) })
    expect(body.length).toBeLessThan(3000)
  })
})
