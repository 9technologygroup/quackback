import { describe, expect, it } from 'vitest'
import { rssAlternateLink } from '../rss-alternate'

describe('rssAlternateLink', () => {
  it('offers the status feed on the status page and an incident page', () => {
    for (const leaf of ['/_portal/status/', '/_portal/status/$incidentId']) {
      expect(
        rssAlternateLink(['__root__', '/_portal', leaf], { statusFeedReadable: true })
      ).toMatchObject({
        rel: 'alternate',
        type: 'application/rss+xml',
        href: '/status/feed',
      })
    }
  })

  it('keeps offering the changelog feed everywhere else', () => {
    for (const leaf of ['/_portal/', '/_portal/changelog/', '/admin/status']) {
      expect(rssAlternateLink(['__root__', leaf], { statusFeedReadable: true }).href).toBe(
        '/changelog/feed'
      )
    }
  })

  it('does not advertise a status feed a feed reader would get empty', () => {
    // A feed reader has no session, so the feed of a non-public page is empty.
    expect(
      rssAlternateLink(['__root__', '/_portal', '/_portal/status/'], { statusFeedReadable: false })
        .href
    ).toBe('/changelog/feed')
  })
})
