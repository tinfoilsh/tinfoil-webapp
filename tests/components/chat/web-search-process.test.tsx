import { WebSearchProcess } from '@/components/chat/renderers/components/WebSearchProcess'
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

describe('WebSearchProcess', () => {
  it('reserves chevron spacing for failed searches without sources', () => {
    const { container } = render(
      createElement(WebSearchProcess, {
        webSearch: {
          query: 'xxx',
          status: 'failed',
          sources: [],
        },
      }),
    )

    expect(screen.getByRole('button')).toHaveTextContent(
      'Search failed for "xxx"',
    )
    const slot = container.querySelector('button > span[aria-hidden="true"]')
    expect(slot).toHaveClass('invisible', 'h-3.5', 'w-3.5', 'shrink-0')
    expect(slot).not.toHaveClass('hidden')
    expect(slot).not.toHaveStyle({ display: 'none' })
    expect(screen.getByRole('button')).toBeDisabled()
  })
})
