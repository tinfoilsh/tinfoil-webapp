import { initializeRenderers } from '@/components/chat/renderers/client'
import { SharedChatView } from '@/components/chat/shared-chat-view'
import type { BaseModel } from '@/config/models'
import { harnessAPI } from '@/services/harness/runtime'
import { speechPlayer } from '@/services/speech/player'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { client, signIn } from '../../harness-fixture'
import { FakeAudioContext } from '../../services/speech/fixtures'

const audio = vi.hoisted(() => ({ context: vi.fn() }))
vi.mock('@/utils/audio-context', () => ({
  getAudioContextClass: () => audio.context,
}))

const model: BaseModel = {
  id: 'test-model',
  label: 'Test model',
  shortLabel: 'Test',
  icon: '',
  description: '',
  badges: [],
  reasoning: null,
  deprecated: false,
}

beforeAll(() => initializeRenderers())
afterEach(() => speechPlayer.stop())

it("keeps loading a shared image when the viewer's content key changes", async () => {
  let finish!: (image: Blob) => void
  // Like a fetch, the download fails once its signal aborts.
  vi.mocked(harnessAPI().client.download).mockImplementation(
    (_path, _input, signal) =>
      new Promise((resolve, reject) => {
        finish = resolve
        signal?.addEventListener('abort', () => reject(signal.reason))
      }),
  )
  render(
    <SharedChatView
      model={model}
      isDarkMode={false}
      chatData={{
        title: 'Shared chat',
        createdAt: '2026-01-01T00:00:00.000Z',
        messages: [
          {
            id: 'message-1',
            role: 'user',
            content: 'Look at this',
            createdAt: '2026-01-01T00:00:00.000Z',
            attachments: [
              {
                id: 'att_photo',
                kind: 'image',
                fileName: 'photo.png',
                mimeType: 'image/png',
                size: 3,
                attKey: 'share-attachment-key',
              },
            ],
          },
        ],
      }}
    />,
  )
  expect(harnessAPI().client.download).toHaveBeenCalledExactlyOnceWith(
    '/v1/attachments/get-public',
    { id: 'att_photo', attKey: 'share-attachment-key' },
    expect.any(AbortSignal),
  )

  act(() => harnessAPI().invalidateKey())
  await act(async () =>
    finish(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })),
  )

  expect(await screen.findByRole('img', { name: 'photo.png' })).toHaveAttribute(
    'src',
    'data:image/png;base64,AQID',
  )
})

it('offers copy and sources on shared messages but nothing that changes the chat', () => {
  render(
    <SharedChatView
      model={model}
      isDarkMode={false}
      chatData={{
        title: 'Shared chat',
        createdAt: '2026-01-01T00:00:00.000Z',
        messages: [
          {
            id: 'u1',
            role: 'user',
            content: 'What is new?',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'a1',
            role: 'assistant',
            content: 'Plenty.',
            createdAt: '2026-01-01T00:00:00.000Z',
            timeline: [
              {
                id: 'search',
                toolCallId: 'search',
                type: 'tool_call',
                name: 'web_search',
                display: {
                  status: 'completed',
                  query: 'news',
                  sources: [{ url: 'https://example.org', title: 'Source' }],
                },
              },
              { id: 'text', type: 'content', content: 'Plenty.' },
            ],
            annotations: [
              {
                type: 'url_citation',
                url_citation: { url: 'https://example.org', title: 'Source' },
              },
            ],
          },
        ],
      }}
    />,
  )

  const [question, reply] = screen.getAllByRole('article')
  expect(
    within(question)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label')),
  ).toEqual(['Copy message'])
  expect(
    within(reply)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent),
  ).toEqual([
    'Searched the web for "news"',
    'Show 1 source',
    'Copy message',
    'Read aloud',
  ])
})

it("asks the harness to read a shared reply's text aloud, without a key", async () => {
  signIn({ cloud: true })
  const context = new FakeAudioContext()
  audio.context.mockImplementation(function () {
    return context
  })
  // Two samples at half scale.
  client.stream.mockResolvedValue(
    new Response(new Uint8Array([0, 64, 0, 192]), {
      headers: { 'Content-Type': 'audio/pcm' },
    }),
  )
  const message = (
    id: string,
    role: 'user' | 'assistant',
    content: string,
  ) => ({
    id,
    role,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
  })
  render(
    <SharedChatView
      model={model}
      isDarkMode={false}
      chatData={{
        title: 'Shared chat',
        createdAt: '2026-01-01T00:00:00.000Z',
        messages: [
          message('u1', 'user', 'Hi'),
          message('a1', 'assistant', 'Hello.'),
          message('u2', 'user', 'What is 2 + 2?'),
          message('a2', 'assistant', 'It is **4**.'),
        ],
      }}
    />,
  )

  const buttons = screen.getAllByRole('button', { name: 'Read aloud' })
  expect(buttons).toHaveLength(2)
  fireEvent.click(buttons[1])

  await waitFor(() => expect(context.scheduled).toHaveLength(1))
  expect(Array.from(context.scheduled[0].buffer!.getChannelData())).toEqual([
    0.5, -0.5,
  ])
  expect(client.stream).toHaveBeenCalledExactlyOnceWith(
    '/v1/speech',
    { text: 'It is **4**.' },
    expect.any(AbortSignal),
  )
})
