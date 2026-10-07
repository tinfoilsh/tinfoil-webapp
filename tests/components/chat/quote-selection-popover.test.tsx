import { AskSidebar } from '@/components/chat/ask-sidebar'
import { ChatMessages } from '@/components/chat/chat-messages'
import { QuoteSelectionPopover } from '@/components/chat/quote-selection-popover'
import { DefaultMessageRenderer } from '@/components/chat/renderers/default/DefaultMessageRenderer'
import {
  getRendererRegistry,
  resetRendererRegistry,
} from '@/components/chat/renderers/registry'
import type { MessageRenderer } from '@/components/chat/renderers/types'
import { SharedChatView } from '@/components/chat/shared-chat-view'
import type { BaseModel } from '@/config/models'
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

const model: BaseModel = {
  modelName: 'gpt-oss-120b',
  name: 'GPT-OSS 120B',
  nameShort: 'GPT-OSS',
  image: '',
  description: '',
  type: 'chat',
}

const customRenderer: MessageRenderer = {
  id: 'selection-test',
  canRender: (_message, candidate) => candidate.modelName === model.modelName,
  render: ({ message, messageIndex }) => (
    <>
      <section>
        <span>{message.content}</span>
        {messageIndex === 0 && <span>Do not read this surrounding text.</span>}
      </section>
      <p>Renderer footer {messageIndex}</p>
    </>
  ),
}

function Harness({
  enabled,
  onQuote = vi.fn(),
  onAsk = vi.fn(),
  text = 'Selected text',
  messageRole = 'assistant',
}: {
  enabled: boolean
  onQuote?: (text: string) => void
  onAsk?: (text: string) => void
  text?: string
  messageRole?: 'user' | 'assistant'
}) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <>
      <div ref={ref}>
        <ChatMessages
          messages={[
            { role: messageRole, content: text, timestamp: new Date(0) },
            {
              role: messageRole,
              content: 'Another message',
              timestamp: new Date(1),
            },
          ]}
          chatId="selection-test"
          isDarkMode={false}
          models={[model]}
          selectedModel={model.modelName}
          autoIntelligence="high"
          setAutoIntelligence={() => {}}
        />
        <span>Outside message</span>
      </div>
      <span>Outside container</span>
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
  resetRendererRegistry()
  getRendererRegistry().setDefaultMessageRenderer(DefaultMessageRenderer)
  getRendererRegistry().registerMessageRenderer(customRenderer)
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
  resetRendererRegistry()
  window.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
})

describe('QuoteSelectionPopover', () => {
  it.each(['user', 'assistant'] as const)(
    'allows element-node selection endpoints within a %s message',
    (messageRole) => {
      const onQuote = vi.fn()
      render(<Harness enabled messageRole={messageRole} onQuote={onQuote} />)
      selectText()
      const range = window.getSelection()!.getRangeAt(0)
      range.selectNodeContents(screen.getByText('Selected text'))
      flushFrames()
      fireEvent.click(screen.getByRole('button', { name: 'Quote' }))
      expect(onQuote).toHaveBeenCalledWith('Selected text')
    },
  )

  it('allows a selection across nested elements in the same message', () => {
    const onQuote = vi.fn()
    render(<Harness enabled onQuote={onQuote} />)
    selectText()
    const range = window.getSelection()!.getRangeAt(0)
    const endNode = screen.getByText(
      'Do not read this surrounding text.',
    ).firstChild!
    range.setEnd(endNode, endNode.textContent!.length)
    flushFrames()
    fireEvent.click(screen.getByRole('button', { name: 'Quote' }))
    expect(onQuote).toHaveBeenCalledWith(
      'Selected textDo not read this surrounding text.',
    )
  })

  it('allows selections across separate roots of a custom renderer fragment', () => {
    const onQuote = vi.fn()
    render(<Harness enabled onQuote={onQuote} />)
    selectText()
    const range = window.getSelection()!.getRangeAt(0)
    range.setEndAfter(screen.getByText('Renderer footer 0'))
    flushFrames()
    fireEvent.click(screen.getByRole('button', { name: 'Quote' }))
    expect(onQuote).toHaveBeenCalledWith(
      'Selected textDo not read this surrounding text.Renderer footer 0',
    )
  })

  it('does not show actions for non-message text inside the container', () => {
    render(<Harness enabled />)
    selectText('Outside message')
    flushFrames()
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
  })

  it('does not show actions for an editor inside a custom message renderer', () => {
    getRendererRegistry().registerMessageRenderer({
      ...customRenderer,
      render: ({ message }) => <textarea defaultValue={message.content} />,
    })
    render(<Harness enabled />)
    selectText()
    const range = window.getSelection()!.getRangeAt(0)
    range.selectNodeContents(screen.getByDisplayValue('Selected text'))
    expect(window.getSelection()!.toString()).toBe('Selected text')
    flushFrames()
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
  })

  it.each(['Another message', 'Outside message'])(
    'hides existing actions when a selection extends into %s',
    (endText) => {
      render(<Harness enabled />)
      selectText()
      flushFrames()
      expect(screen.getByRole('toolbar')).toBeInTheDocument()

      const range = window.getSelection()!.getRangeAt(0)
      const endNode = screen.getByText(endText).firstChild!
      range.setEnd(endNode, endText.length)
      fireEvent(document, new Event('selectionchange'))
      flushFrames()
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    },
  )

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

describe.each(['custom', 'default'])(
  '%s renderer message hosts',
  (renderer) => {
    beforeEach(() => {
      if (renderer === 'default') {
        getRendererRegistry().reset()
        getRendererRegistry().setDefaultMessageRenderer(DefaultMessageRenderer)
      }
    })

    it.each(['user', 'assistant'] as const)(
      'supports a %s host endpoint and keeps a single focusable boundary per message',
      (messageRole) => {
        const onQuote = vi.fn()
        const { container } = render(
          <Harness enabled messageRole={messageRole} onQuote={onQuote} />,
        )
        const messages = container.querySelectorAll<HTMLElement>(
          '[data-message-role]',
        )
        expect(messages).toHaveLength(2)
        expect(screen.getAllByRole('article')).toHaveLength(2)
        expect(messages[0]).toHaveAccessibleName(
          messageRole === 'user' ? 'You said' : 'Al said',
        )
        messages[1].focus({ preventScroll: true })
        expect(messages[1]).toHaveFocus()

        selectText()
        const range = window.getSelection()!.getRangeAt(0)
        range.setStart(messages[0], 0)
        flushFrames()
        fireEvent.click(screen.getByRole('button', { name: 'Quote' }))
        expect(onQuote).toHaveBeenCalledWith('Selected text')
      },
    )

    it.each(['Another message', 'Outside message', 'Outside container'])(
      'rejects selection extending into %s',
      (endText) => {
        render(<Harness enabled />)
        selectText()
        flushFrames()
        expect(screen.getByRole('toolbar')).toBeInTheDocument()
        const range = window.getSelection()!.getRangeAt(0)
        const node = screen.getByText(endText).firstChild!
        range.setEnd(node, node.textContent!.length)
        fireEvent(document, new Event('selectionchange'))
        flushFrames()
        expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
      },
    )

    it.each(['user', 'assistant'] as const)(
      'quotes a %s message through the real Ask sidebar host',
      (role) => {
        const onQuote = vi.fn()
        render(
          <AskSidebar
            isOpen
            onClose={() => {}}
            onQuote={onQuote}
            state={{
              messages: [
                { role, content: 'Sidebar selection', timestamp: new Date(0) },
              ],
              quote: null,
              loadingState: 'idle',
              isThinking: false,
              isWaitingForResponse: false,
              isStreaming: false,
              retryInfo: null,
            }}
            models={[model]}
            selectedModel={model.modelName}
            isDarkMode={false}
          />,
        )
        selectText('Sidebar selection')
        const range = window.getSelection()!.getRangeAt(0)
        range.setStart(screen.getByRole('article'), 0)
        flushFrames()
        fireEvent.click(screen.getByRole('button', { name: 'Quote' }))
        expect(onQuote).toHaveBeenCalledWith('Sidebar selection')
      },
    )

    it('preserves message boundaries and focus semantics in shared chat', () => {
      const { container } = render(
        <SharedChatView
          chatData={{
            v: 1,
            title: 'Shared conversation',
            createdAt: 0,
            messages: [
              { role: 'user', content: 'Shared prompt', timestamp: 0 },
              { role: 'assistant', content: 'Shared answer', timestamp: 1 },
            ],
          }}
          model={model}
          isDarkMode={false}
        />,
      )
      const messages = container.querySelectorAll<HTMLElement>(
        '[data-message-role]',
      )
      expect(messages).toHaveLength(2)
      expect(screen.getAllByRole('article')).toHaveLength(2)
      expect(messages[0]).toContainElement(screen.getByText('Shared prompt'))
      expect(messages[1]).toContainElement(screen.getByText('Shared answer'))
      expect(messages[0]).toHaveAccessibleName('You said')
      expect(messages[1]).toHaveAccessibleName('Al said')
      messages[1].focus({ preventScroll: true })
      expect(messages[1]).toHaveFocus()
    })
  },
)
