import {
  chatChunkStreamFromSSE,
  type ChatChunk,
} from '@/services/inference/chat-stream'
import { describe, expect, it } from 'vitest'

function mockResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  let index = 0
  const readable = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index++
      } else {
        controller.close()
      }
    },
  })
  return new Response(readable)
}

async function collectAll(response: Response): Promise<ChatChunk[]> {
  const results: ChatChunk[] = []
  for await (const chunk of chatChunkStreamFromSSE(response)) {
    results.push(chunk)
  }
  return results
}

describe('chatChunkStreamFromSSE', () => {
  it('handles multiple events in one chunk', async () => {
    const results = await collectAll(
      mockResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"id":"2"}\n\n',
      ]),
    )
    expect(results).toEqual([
      { choices: [{ delta: { content: 'hi' } }] },
      { id: '2' },
    ])
  })

  it('reassembles events split across chunks', async () => {
    const results = await collectAll(
      mockResponse(['data: {"id":', '"split"}\n\n']),
    )
    expect(results).toEqual([{ id: 'split' }])
  })

  it('stops on the DONE sentinel', async () => {
    const results = await collectAll(
      mockResponse([
        'data: {"id":"1"}\n\ndata: [DONE]\n\ndata: {"id":"2"}\n\n',
      ]),
    )
    expect(results).toEqual([{ id: '1' }])
  })

  it('cancels the response body after the DONE sentinel', async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        },
        cancel() {
          cancelled = true
        },
      }),
    )

    await collectAll(response)

    expect(cancelled).toBe(true)
  })

  it('skips non-data and empty lines', async () => {
    const results = await collectAll(
      mockResponse([
        '\n\n{"id":"not-data"}\nevent: message\ndata:\ndata: {"id":"1"}\n\n\n\n',
      ]),
    )
    expect(results).toEqual([{ id: '1' }])
  })

  it('skips malformed JSON', async () => {
    const results = await collectAll(
      mockResponse(['data: {bad json}\n\ndata: {"id":"good"}\n\n']),
    )
    expect(results).toEqual([{ id: 'good' }])
  })

  it('skips non-object JSON', async () => {
    const results = await collectAll(
      mockResponse([
        'data: null\n\ndata: ["invalid"]\n\ndata: {"id":"good"}\n\n',
      ]),
    )
    expect(results).toEqual([{ id: 'good' }])
  })

  it('returns nothing for an empty response body', async () => {
    await expect(collectAll(new Response(null))).resolves.toEqual([])
  })

  it('handles CRLF line endings', async () => {
    const results = await collectAll(
      mockResponse(['data: {"id":"1"}\r\n\r\ndata: {"id":"2"}\r\n\r\n']),
    )
    expect(results).toEqual([{ id: '1' }, { id: '2' }])
  })

  it('preserves response stream errors', async () => {
    const streamError = new Error('stream failed')
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(streamError)
        },
      }),
    )

    await expect(collectAll(response)).rejects.toBe(streamError)
  })
})
