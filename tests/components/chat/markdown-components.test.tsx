import { MessageContent } from '@/components/chat/renderers/components/MessageContent'
import { harnessAPI } from '@/services/harness/runtime'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchFavicon = vi.fn<(url: string) => Promise<{ status: string }>>()

beforeEach(() => {
  fetchFavicon.mockReset().mockImplementation(async () => {
    throw new Error('Unexpected favicon lookup')
  })
  vi.mocked(harnessAPI().client.post).mockImplementation(
    async (path: string, input: unknown) => {
      if (path !== '/v1/metadata/favicon')
        throw new Error(`Unexpected request: ${path}`)
      return fetchFavicon((input as { url: string }).url)
    },
  )
})

describe('Markdown citations', () => {
  it.each([
    {
      isStreaming: true,
      url: 'https://streaming.test/article',
      domain: 'streaming',
    },
    {
      isStreaming: false,
      url: 'https://finished.test/article',
      domain: 'finished',
    },
  ])(
    'renders citation links as pills (streaming: $isStreaming)',
    async ({ isStreaming, url, domain }) => {
      const citationUrlTitles = new Map([[url, 'Example']])
      fetchFavicon.mockImplementationOnce(async (requested) => {
        expect(requested).toBe(url)
        return { status: 'missing' }
      })
      await act(async () => {
        render(
          <MessageContent
            content={`[source](${url})\n\n[Ordinary source](https://ordinary.test/page)`}
            isDarkMode={false}
            isStreaming={isStreaming}
            citationUrlTitles={citationUrlTitles}
          />,
        )
      })
      expect(fetchFavicon).toHaveBeenCalledExactlyOnceWith(url)
      const citation = screen.getByRole('link', { name: domain })
      expect(citation).toHaveAttribute('href', url)
      expect(citation).toHaveClass('align-middle', 'leading-none')
      const ordinary = screen.getByRole('link', { name: 'Ordinary source' })
      expect(ordinary).toHaveAttribute('href', 'https://ordinary.test/page')
      expect(ordinary).not.toHaveClass('align-middle')
    },
  )
})
