import {
  ImageGalleryProvider,
  useImageGallery,
} from '@/components/chat/image-gallery-context'
import type { Message } from '@/components/chat/types'
import { render } from '@testing-library/react'
import { expect, it } from 'vitest'

const SENT = new Date('2026-11-04T12:00:00Z')

const question: Message = {
  id: 'question',
  role: 'user',
  content: 'What is in this picture?',
  timestamp: SENT,
  attachments: [
    {
      id: 'att_sunset',
      type: 'image',
      fileName: 'sunset.jpg',
      mimeType: 'image/jpeg',
      thumbnailBase64: 'c3Vuc2V0',
    },
  ],
}

const reply = (content: string): Message => ({
  id: 'reply',
  role: 'assistant',
  content,
  timestamp: SENT,
})

it('keeps the gallery as it was while a reply streams, and changes it when an image is added', () => {
  const seen: ReturnType<typeof useImageGallery>[] = []
  function Images() {
    const gallery = useImageGallery()
    if (seen.at(-1) !== gallery) seen.push(gallery)
    return null
  }
  const shown = (messages: Message[]) => (
    <ImageGalleryProvider messages={messages}>
      <Images />
    </ImageGalleryProvider>
  )

  const { rerender } = render(shown([question, reply('A')]))
  rerender(shown([question, reply('A sun')]))
  rerender(shown([question, reply('A sunset over the sea')]))

  expect(seen).toHaveLength(1)
  expect(seen[0]?.imageByKey('0:0')).toMatchObject({
    src: 'data:image/jpeg;base64,c3Vuc2V0',
    failed: false,
  })

  const withImage: Message = {
    ...reply('A sunset over the sea'),
    attachments: [
      {
        id: 'att_drawing',
        type: 'image',
        fileName: 'drawing.png',
        mimeType: 'image/png',
        thumbnailBase64: 'ZHJhd2luZw==',
      },
    ],
  }
  rerender(shown([question, withImage]))

  expect(seen).toHaveLength(2)
  expect(seen[1]?.imageByKey('1:0')).toMatchObject({
    src: 'data:image/png;base64,ZHJhd2luZw==',
  })
  expect(seen[1]?.imageByKey('0:0')?.src).toBe(
    'data:image/jpeg;base64,c3Vuc2V0',
  )
})
