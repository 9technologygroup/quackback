import { describe, it, expect, vi } from 'vitest'
import { streamOf } from '@/test/sse'
import { parseAskAiSseBlock, readAskAiStream } from '../ask-ai'

describe('parseAskAiSseBlock', () => {
  it('parses event and JSON data lines', () => {
    const parsed = parseAskAiSseBlock('event: kb-ask.v1.delta\ndata: {"text":"hi"}')
    expect(parsed).toEqual({ event: 'kb-ask.v1.delta', data: { text: 'hi' } })
  })

  it('returns null for comments and malformed blocks', () => {
    expect(parseAskAiSseBlock(': ping')).toBeNull()
    expect(parseAskAiSseBlock('event: x\ndata: {broken')).toBeNull()
  })
})

describe('readAskAiStream', () => {
  it('dispatches versioned events across chunk boundaries', async () => {
    const sources = [
      {
        articleId: 'kb_article_1',
        title: 'T',
        slug: 's',
        categorySlug: 'c',
        categoryName: 'C',
      },
    ]
    const frames =
      `event: kb-ask.v1.sources\ndata: ${JSON.stringify({ sources })}\n\n` +
      `event: kb-ask.v1.delta\ndata: {"text":"Hello "}\n\n` +
      `event: kb-ask.v1.delta\ndata: {"text":"world"}\n\n` +
      `event: kb-ask.v1.final\ndata: {"answer":"Hello world","sources":[{"articleId":"kb_article_1"}]}\n\n`
    // Split at awkward boundaries to prove buffering works.
    const chunks = [frames.slice(0, 25), frames.slice(25, 90), frames.slice(90)]

    const onSources = vi.fn()
    const onDelta = vi.fn()
    const onFinal = vi.fn()

    await readAskAiStream(streamOf(chunks), { onSources, onDelta, onFinal })

    expect(onSources).toHaveBeenCalledWith(sources)
    expect(onDelta.mock.calls.map((c) => c[0]).join('')).toBe('Hello world')
    expect(onFinal).toHaveBeenCalledWith({
      answer: 'Hello world',
      sources: [{ articleId: 'kb_article_1' }],
    })
  })

  it('dispatches error events and ignores unknown ones', async () => {
    const frames =
      `event: kb-ask.v2.something-new\ndata: {}\n\n` +
      `event: kb-ask.v1.error\ndata: {"code":"SYNTHESIS_FAILED","message":"x"}\n\n`
    const onError = vi.fn()
    const onFinal = vi.fn()

    await readAskAiStream(streamOf([frames]), { onError, onFinal })

    expect(onError).toHaveBeenCalledWith('SYNTHESIS_FAILED')
    expect(onFinal).not.toHaveBeenCalled()
  })
})
