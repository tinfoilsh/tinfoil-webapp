import { createMarkdownComponents } from '@/components/chat/renderers/components/markdown-components'
import { TooltipProvider } from '@/components/ui/tooltip'
import { act, render, screen } from '@testing-library/react'
import { createElement, type ElementType } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchFavicon } = vi.hoisted(() => ({
  fetchFavicon: vi.fn<(url: string) => Promise<string | null>>(),
}))
vi.mock('@/services/inference/metadata-client', () => ({ fetchFavicon }))

beforeEach(() => {
  fetchFavicon.mockReset().mockImplementation(async () => {
    throw new Error('Unexpected favicon lookup')
  })
})

describe('createMarkdownComponents citations', () => {
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
        return null
      })
      const components = createMarkdownComponents({
        isDarkMode: false,
        isStreaming,
        showMarkdownTablePlaceholder: false,
        citationUrlTitles,
      })

      await act(async () => {
        render(
          createElement(
            TooltipProvider,
            null,
            createElement(components.a as ElementType, { href: url }, 'source'),
            createElement(
              components.a as ElementType,
              { href: 'https://ordinary.test/page' },
              'Ordinary source',
            ),
          ),
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
