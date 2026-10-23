import { initializeRenderers } from '@/components/chat/renderers/client'
import { SharedChatView } from '@/components/chat/shared-chat-view'
import type { BaseModel } from '@/config/models'
import { harnessAPI } from '@/services/harness/runtime'
import { act, render, screen } from '@testing-library/react'
import { beforeAll, expect, it, vi } from 'vitest'

const model: BaseModel = {
  modelName: 'test-model',
  name: 'Test model',
  nameShort: 'Test',
  image: '',
  description: '',
  type: 'chat',
  chat: true,
}

beforeAll(() => initializeRenderers())

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
                thumbnail: null,
                attKey: 'share-attachment-key',
                status: 'ready',
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
