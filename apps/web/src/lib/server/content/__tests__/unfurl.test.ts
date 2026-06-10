import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mocks must exist before the module factories run — vi.hoisted lifts them.
const { safeFetch, uploadImageBuffer, sniffImageMime } = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  uploadImageBuffer: vi.fn(),
  sniffImageMime: vi.fn(),
}))

vi.mock('../ssrf-guard', () => ({
  safeFetch,
  SsrfError: class SsrfError extends Error {},
  TimeoutError: class TimeoutError extends Error {},
  ResponseTooLargeError: class ResponseTooLargeError extends Error {},
}))
vi.mock('../magic-bytes', () => ({
  sniffImageMime,
  ALLOWED_REHOST_MIMES: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
}))
vi.mock('@/lib/server/storage/s3', () => ({ uploadImageBuffer }))

import { unfurlExternalUrl } from '../unfurl'

const page = (meta: string) => `<html><head>${meta}</head><body>x</body></html>`
const htmlRes = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
const redirect = (location: string, status = 301) =>
  new Response(null, { status, headers: { location } })
const imageRes = (bytes: number[], mime: string) =>
  new Response(Buffer.from(bytes), { status: 200, headers: { 'content-type': mime } })

beforeEach(() => {
  safeFetch.mockReset()
  uploadImageBuffer.mockReset()
  sniffImageMime.mockReset()
})

describe('unfurlExternalUrl', () => {
  it('follows a redirect (re-validating each hop via safeFetch) then parses OG tags', async () => {
    safeFetch
      .mockResolvedValueOnce(redirect('https://final.example/page'))
      .mockResolvedValueOnce(htmlRes(page('<meta property="og:title" content="Hello">')))

    const res = await unfurlExternalUrl('https://start.example/')

    expect(res?.title).toBe('Hello')
    expect(res?.url).toBe('https://final.example/page')
    // Each hop went through safeFetch (so each redirect target is SSRF-validated).
    expect(safeFetch).toHaveBeenNthCalledWith(1, 'https://start.example/', expect.any(Object))
    expect(safeFetch).toHaveBeenNthCalledWith(2, 'https://final.example/page', expect.any(Object))
  })

  it('gives up (null) past the redirect cap rather than looping', async () => {
    safeFetch.mockResolvedValue(redirect('https://loop.example/next'))
    const res = await unfurlExternalUrl('https://start.example/')
    expect(res).toBeNull()
    expect(safeFetch.mock.calls.length).toBeLessThanOrEqual(4) // MAX_REDIRECTS + 1
  })

  it('returns null when safeFetch rejects (SSRF / timeout)', async () => {
    safeFetch.mockRejectedValueOnce(new Error('blocked by SSRF guard'))
    expect(await unfurlExternalUrl('https://evil.example/')).toBeNull()
  })

  it('returns null for non-HTML content', async () => {
    safeFetch.mockResolvedValueOnce(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    )
    expect(await unfurlExternalUrl('https://api.example/')).toBeNull()
  })

  it('rejects an SVG og:image before sniffing, keeping the text preview', async () => {
    safeFetch
      .mockResolvedValueOnce(
        htmlRes(
          page(
            '<meta property="og:title" content="T"><meta property="og:image" content="https://img.example/p.svg">'
          )
        )
      )
      .mockResolvedValueOnce(
        new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } })
      )

    const res = await unfurlExternalUrl('https://site.example/')
    expect(res?.title).toBe('T')
    expect(res?.imageUrl).toBeNull()
    expect(sniffImageMime).not.toHaveBeenCalled()
    expect(uploadImageBuffer).not.toHaveBeenCalled()
  })

  it('drops the image when magic bytes disagree with the declared mime', async () => {
    safeFetch
      .mockResolvedValueOnce(
        htmlRes(
          page(
            '<meta property="og:title" content="T"><meta property="og:image" content="https://img.example/p.png">'
          )
        )
      )
      .mockResolvedValueOnce(imageRes([1, 2, 3], 'image/png'))
    sniffImageMime.mockReturnValue('image/gif') // mismatch with declared image/png

    const res = await unfurlExternalUrl('https://site.example/')
    expect(res?.imageUrl).toBeNull()
    expect(uploadImageBuffer).not.toHaveBeenCalled()
  })

  it('proxies a verified image through our storage (never hotlinks)', async () => {
    safeFetch
      .mockResolvedValueOnce(
        htmlRes(
          page(
            '<meta property="og:title" content="T"><meta property="og:image" content="https://img.example/p.png">'
          )
        )
      )
      .mockResolvedValueOnce(imageRes([0x89, 0x50, 0x4e, 0x47], 'image/png'))
    sniffImageMime.mockReturnValue('image/png')
    uploadImageBuffer.mockResolvedValue({ url: '/api/storage/link-previews/abc.png' })

    const res = await unfurlExternalUrl('https://site.example/')
    expect(res?.imageUrl).toBe('/api/storage/link-previews/abc.png')
    expect(uploadImageBuffer).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', 'link-previews')
  })
})
