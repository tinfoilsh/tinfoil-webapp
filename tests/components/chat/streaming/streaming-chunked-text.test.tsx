import { StreamingChunkedText } from '@/components/chat/renderers/components/StreamingChunkedText'
import { StreamingContentWrapper } from '@/components/chat/renderers/components/StreamingContentWrapper'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('StreamingChunkedText', () => {
  it('renders and updates short live text without an inline mask', () => {
    const content = '```js\nconst ready = true\n```\nHi'
    const view = (text: string) => (
      <StreamingContentWrapper isStreaming>
        <StreamingChunkedText
          content={text}
          isDarkMode={false}
          isStreaming={true}
        />
      </StreamingContentWrapper>
    )
    const { container, rerender } = render(view(content))

    expect(container).toHaveTextContent('const ready = true')
    expect(container).toHaveTextContent('Hi')
    expect(screen.getByText('Hi')).toBeVisible()
    rerender(view(`${content} there`))
    expect(screen.getByText('Hi there')).toBeVisible()
    expect(container).toHaveTextContent('const ready = true')
    expect(container.querySelector('[style*="mask-image"]')).toBeNull()
  })
})
