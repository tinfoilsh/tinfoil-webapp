import { StepMarkdown } from '@/components/chat/renderers/components/StepMarkdown'
import { ThoughtProcess } from '@/components/chat/renderers/components/ThoughtProcess'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import { beforeAll, expect, it, vi } from 'vitest'

// Each render of a markdown block parses its text.
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>()
  return { ...actual, default: vi.fn(actual.default) }
})

beforeAll(async () => {
  // The math plugins load once; thoughts render with them from then on.
  const { container, unmount } = render(<StepMarkdown content="$$x$$" />)
  await waitFor(() => expect(container.querySelector('.katex')).not.toBeNull())
  unmount()
})

it('measures expanded thoughts once and parses only their last block as they stream', () => {
  let observers = 0
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor() {
        observers++
      }
      observe() {}
      disconnect() {}
    },
  )
  const thoughts = (text: string) => (
    <ThoughtProcess thoughts={text} isDarkMode={false} isThinking />
  )
  const { rerender } = render(thoughts('First idea.\n\nSecond'))
  const shown = observers
  fireEvent.click(screen.getByRole('button', { name: /Thinking/ }))
  expect(screen.getByText('First idea.')).toBeInTheDocument()
  const expanded = observers
  expect(expanded).toBeGreaterThan(shown)
  vi.mocked(ReactMarkdown).mockClear()

  rerender(thoughts('First idea.\n\nSecond idea'))
  rerender(thoughts('First idea.\n\nSecond idea grows'))

  expect(screen.getByText('Second idea grows')).toBeInTheDocument()
  expect(observers).toBe(expanded)
  expect(
    vi.mocked(ReactMarkdown).mock.calls.map(([props]) => props.children),
  ).toEqual(['Second idea', 'Second idea grows'])
})
