/**
 * Shared fixtures for tests that exercise the assistant's POST+SSE streaming
 * surfaces (the Copilot panel, the suggested-reply store/card): building
 * versioned SSE frames, wrapping them in a one-shot `ReadableStream`, and
 * stubbing global `fetch` with a streaming `Response`. Kept here so every
 * suite fakes the wire format the same way `readSseBlocks`/
 * `parseAskAiSseBlock` actually parse it.
 */
import { vi } from 'vitest'

/** One `event:`/`data:` SSE block, JSON-encoding `data`. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** A byte stream of `text` that then closes — the shape a completed SSE
 *  response body reads as. Pass an array to deliver multiple chunks (e.g. to
 *  prove frame buffering across awkward chunk boundaries). */
export function streamOf(text: string | string[]): ReadableStream<Uint8Array> {
  const chunks = Array.isArray(text) ? text : [text]
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

/** An `ok` streaming `Response` whose body replays `frames` once. Build a
 *  FRESH one per fetch call (see `stubStreamingFetch`) — a stream can only be
 *  consumed once. */
export function mockStreamingResponse(frames: string): Response {
  return { ok: true, body: streamOf(frames) } as Response
}

/** Stub global `fetch` to resolve a fresh streaming response of `frames` on
 *  every call (`mockResolvedValue` would hand the SAME already-consumed
 *  stream to a second fetch). Returns the mock for call assertions; undo via
 *  `vi.unstubAllGlobals()`. */
export function stubStreamingFetch(frames: string) {
  const fetchMock = vi.fn(() => Promise.resolve(mockStreamingResponse(frames)))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
