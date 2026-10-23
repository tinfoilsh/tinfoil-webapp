import { GenUIToolCallRenderer } from '@/components/chat/genui/GenUIToolCallRenderer'
import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import { client, signIn } from '../../../harness-fixture'

// The pages the harness reads; each test reads its own, since read pages are
// remembered for the session. A lookup starts as the preview renders.
let pages: Record<string, Record<string, unknown>>

beforeEach(() => {
  signIn()
  pages = {}
  client.post.mockImplementation(async (path: string, input: unknown) => {
    const { url } = input as { url: string }
    if (path === '/v1/metadata/link' && pages[url]) return pages[url]
    if (path === '/v1/metadata/favicon') return { status: 'not_found' }
    throw new Error(`Unexpected ${path}`)
  })
})

const linkRequests = () =>
  client.post.mock.calls
    .filter(([path]) => path === '/v1/metadata/link')
    .map(([, input]) => input)

function renderPreview(
  url: string,
  { result, isStreaming = false }: { result?: unknown; isStreaming?: boolean },
) {
  render(
    <GenUIToolCallRenderer
      isStreaming={isStreaming}
      toolCalls={[
        {
          id: 'preview-1',
          name: 'render_link_preview',
          arguments: JSON.stringify({ url, title: 'Model title' }),
          ...(result !== undefined ? { result } : {}),
        },
      ]}
    />,
  )
}

it("reads a stored preview's page when the chat kept none of its details", async () => {
  const url = 'https://example.com/old-post'
  pages[url] = {
    url,
    title: 'Example post',
    description: 'What the page says about itself',
    siteName: 'Example',
    image: null,
  }

  renderPreview(url, {})

  expect(
    await screen.findByText('What the page says about itself'),
  ).toBeInTheDocument()
  expect(screen.getByText('Example post')).toBeInTheDocument()
  expect(screen.getByText('Example')).toBeInTheDocument()
  expect(linkRequests()).toEqual([{ url }])
})

it('shows the details a preview carries without reading its page', () => {
  const url = 'https://example.com/new-post'
  renderPreview(url, {
    result: {
      url,
      title: 'Stored title',
      description: 'Stored description',
      siteName: 'Stored site',
      image: null,
    },
  })

  expect(screen.getByText('Stored description')).toBeInTheDocument()
  expect(linkRequests()).toEqual([])
})

it('waits for a streaming preview to receive its own details', () => {
  const url = 'https://example.com/live-post'
  renderPreview(url, { isStreaming: true })

  expect(screen.getByText('Model title')).toBeInTheDocument()
  expect(linkRequests()).toEqual([])
})
