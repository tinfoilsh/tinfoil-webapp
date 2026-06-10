import { MessageQueue } from '@/components/chat/message-queue'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

describe('MessageQueue', () => {
  it('renders image attachments for queued messages', () => {
    render(
      <MessageQueue
        queue={[
          {
            id: 'queued-1',
            text: '',
            attachments: [
              {
                id: 'image-1',
                type: 'image',
                fileName: 'cat.png',
                mimeType: 'image/png',
                thumbnailBase64: 'thumbnail-data',
                base64: 'full-data',
              },
            ],
          },
        ]}
        onRemove={vi.fn()}
      />,
    )

    const image = screen.getByRole('img', { name: 'cat.png' })
    expect(image).toHaveAttribute('src', 'data:image/png;base64,thumbnail-data')
  })
})
