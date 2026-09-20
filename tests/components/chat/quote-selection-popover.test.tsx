import { QuoteSelectionPopover } from '@/components/chat/quote-selection-popover'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  controlledSpeech,
  FakeAudioContext,
} from '../../services/speech/fixtures'

const audioMocks = vi.hoisted(() => ({ stream: vi.fn(), context: vi.fn() }))
vi.mock('@/services/speech/player', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/services/speech/player')>()
  return {
    ...original,
    speechPlayer: new original.SpeechPlayer(
      audioMocks.stream,
      audioMocks.context,
    ),
  }
})
let generation: ReturnType<typeof controlledSpeech>
let audio: FakeAudioContext

const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0

function Harness({
  enabled,
  onQuote = vi.fn(),
  onAsk = vi.fn(),
  text = 'Selected text',
}: {
  enabled: boolean
  onQuote?: (text: string) => void
  onAsk?: (text: string) => void
  text?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <>
      <div ref={ref}>
        <span>{text}</span>
        <span>Do not read this surrounding text.</span>
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

function selectText(text = 'Selected text', start = 0, end = text.length) {
  const range = document.createRange()
  const node = screen.getByText(text).firstChild!
  range.setStart(node, start)
  range.setEnd(node, end)
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
  generation = controlledSpeech()
  audio = new FakeAudioContext()
  audioMocks.stream.mockImplementation(generation.stream)
  audioMocks.context.mockReturnValue(audio)
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
  it('reads only the highlighted portion and keeps a stop control in the menu', async () => {
    render(<Harness enabled />)
    selectText('Selected text', 9)
    flushFrames()
    const button = screen.getByRole('button', { name: 'Read' })
    expect(button).toHaveTextContent('Read')
    fireEvent.mouseDown(button)
    fireEvent.click(button)
    await waitFor(() => expect(generation.requests).toHaveLength(1))
    expect(generation.requests[0].text).toBe('text')
    expect(window.getSelection()?.toString()).toBe('text')
    expect(screen.getByRole('toolbar')).toBeInTheDocument()
    await act(async () => {
      generation.requests[0].push(2)
      generation.requests[0].finish()
    })
    const stop = screen.getByRole('button', { name: 'Stop reading aloud' })
    expect(stop).toHaveClass('animate-pulse', 'text-red-600')
    fireEvent.click(stop)
    expect(audio.close).toHaveBeenCalledOnce()
  })

  it('does not reinterpret selected text as Markdown', async () => {
    const text = '**literal** [1](source)'
    render(<Harness enabled text={text} />)
    selectText(text)
    flushFrames()
    fireEvent.click(screen.getByRole('button', { name: 'Read' }))
    await waitFor(() => expect(generation.requests).toHaveLength(1))
    expect(generation.requests[0].text).toBe(text)
  })

  it('cancels speech when the selection menu is dismissed', async () => {
    render(<Harness enabled />)
    selectText()
    flushFrames()
    fireEvent.click(screen.getByRole('button', { name: 'Read' }))
    await waitFor(() => expect(generation.requests).toHaveLength(1))
    window.getSelection()?.removeAllRanges()
    fireEvent(document, new Event('selectionchange'))
    flushFrames()
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    expect(generation.requests[0].signal.aborted).toBe(true)
    expect(audio.close).toHaveBeenCalledOnce()
  })

  it('keeps the wider toolbar inside the viewport near either edge', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 300, 32),
    )
    render(<Harness enabled />)
    selectText()
    const range = window.getSelection()!.getRangeAt(0)
    vi.mocked(range.getBoundingClientRect).mockReturnValue(
      new DOMRect(0, 20, 10, 20),
    )
    flushFrames()
    expect(screen.getByRole('toolbar')).toHaveStyle({
      left: '158px',
      top: '8px',
    })
    vi.mocked(range.getBoundingClientRect).mockReturnValue(
      new DOMRect(window.innerWidth - 10, 100, 10, 20),
    )
    fireEvent(document, new Event('selectionchange'))
    flushFrames()
    expect(screen.getByRole('toolbar')).toHaveStyle({
      left: `${window.innerWidth - 158}px`,
    })
  })
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
