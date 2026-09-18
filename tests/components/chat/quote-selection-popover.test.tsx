import { QuoteSelectionPopover } from '@/components/chat/quote-selection-popover'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0

function Harness({
  enabled,
  onQuote = vi.fn(),
  onAsk = vi.fn(),
}: {
  enabled: boolean
  onQuote?: (text: string) => void
  onAsk?: (text: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <>
      <div ref={ref}>
        <span>Selected text</span>
      </div>
      <QuoteSelectionPopover
        enabled={enabled}
        containerRef={ref}
        onQuote={onQuote}
        onAsk={onAsk}
      />
    </>
  )
}

function selectText() {
  const range = document.createRange()
  range.selectNodeContents(screen.getByText('Selected text'))
  vi.spyOn(range, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(100, 100, 120, 20),
  )
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  fireEvent(document, new Event('selectionchange'))
}

function flushFrames() {
  act(() => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((callback) => callback(0))
  })
}

beforeEach(() => {
  frames.clear()
  nextFrame = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id)
  })
})

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
})

describe('QuoteSelectionPopover', () => {
  it.each(['scroll', 'resize'])(
    'cancels a queued selection update on %s',
    (eventName) => {
      render(<Harness enabled />)
      selectText()
      fireEvent(window, new Event(eventName))
      flushFrames()
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
      selectText()
      flushFrames()
      expect(screen.getByRole('toolbar')).toBeInTheDocument()
    },
  )
  it('does not show actions when selection is disabled for the welcome screen', () => {
    render(<Harness enabled={false} />)
    selectText()
    fireEvent.mouseUp(document)
    flushFrames()
    expect(
      screen.queryByRole('toolbar', { name: 'Selection actions' }),
    ).not.toBeInTheDocument()
  })

  it.each(['Quote', 'Ask'])(
    'keeps the %s action working for conversation selections',
    (action) => {
      const onQuote = vi.fn()
      const onAsk = vi.fn()
      render(<Harness enabled onQuote={onQuote} onAsk={onAsk} />)
      selectText()
      flushFrames()
      fireEvent.click(screen.getByRole('button', { name: action }))
      expect(action === 'Quote' ? onQuote : onAsk).toHaveBeenCalledWith(
        'Selected text',
      )
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    },
  )

  it('clears visible and queued actions when switching back to the welcome screen', () => {
    const { rerender } = render(<Harness enabled />)
    selectText()
    flushFrames()
    expect(screen.getByRole('toolbar')).toBeInTheDocument()
    fireEvent.mouseUp(document)
    rerender(<Harness enabled={false} />)
    flushFrames()
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    rerender(<Harness enabled />)
    flushFrames()
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
  })
})
