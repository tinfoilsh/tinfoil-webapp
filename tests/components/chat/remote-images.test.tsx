import { GenUIToolCallRenderer } from '@/components/chat/genui/GenUIToolCallRenderer'
import { MessageContent } from '@/components/chat/renderers/components/MessageContent'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { client, signIn } from '../../harness-fixture'

const SOURCE = 'https://images.example/private-token.png'
const DATA_URL = 'data:image/png;base64,AQID'

beforeEach(() => {
  signIn()
  client.post.mockImplementation(async (path) => {
    if (path === '/v1/metadata/image')
      return { image_bytes: 'AQID', image_content_type: 'image/png' }
    if (path === '/v1/metadata/favicon') return { status: 'missing' }
    throw new Error('Unexpected request')
  })
})

function widget(name: string, args: object) {
  return (
    <GenUIToolCallRenderer
      isStreaming={false}
      toolCalls={[{ id: 'image-call', name, arguments: JSON.stringify(args) }]}
    />
  )
}

it('loads Markdown images through the harness', async () => {
  render(
    <MessageContent
      content={`![Private image](${SOURCE})`}
      isDarkMode={false}
    />,
  )
  await waitFor(() =>
    expect(screen.getByRole('img', { name: 'Private image' })).toHaveAttribute(
      'src',
      DATA_URL,
    ),
  )
  expect(document.querySelector(`img[src="${SOURCE}"]`)).toBeNull()
})

it('uses the same private image bytes in the gallery and lightbox', async () => {
  render(widget('render_image', { images: [{ url: SOURCE, alt: 'Photo' }] }))
  await waitFor(() =>
    expect(screen.getByRole('img', { name: 'Photo' })).toHaveAttribute(
      'src',
      DATA_URL,
    ),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Open image preview' }))
  await waitFor(() => {
    const pictures = screen.getAllByRole('img', { name: 'Photo' })
    expect(pictures).toHaveLength(2)
    for (const picture of pictures)
      expect(picture).toHaveAttribute('src', DATA_URL)
  })
  expect(
    client.post.mock.calls.filter(([path]) => path === '/v1/metadata/image'),
  ).toHaveLength(1)
})

it('embeds fetched bytes when printing a recipe', async () => {
  const printDocument = {
    open: vi.fn(),
    write: vi.fn(),
    close: vi.fn(),
    readyState: 'complete',
  }
  const printWindow = {
    document: printDocument,
    focus: vi.fn(),
    print: vi.fn(),
    closed: false,
  }
  vi.spyOn(window, 'open').mockReturnValue(printWindow as unknown as Window)
  render(
    widget('render_recipe_card', {
      title: 'Soup',
      image: SOURCE,
      ingredients: [],
      steps: [],
    }),
  )
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: /print/i })),
  )
  await waitFor(() => expect(printDocument.write).toHaveBeenCalledTimes(1))
  const html = String(printDocument.write.mock.calls[0][0])
  expect(html).toContain(DATA_URL)
  expect(html).not.toContain(SOURCE)
  expect(printWindow.print).toHaveBeenCalledTimes(1)
})
