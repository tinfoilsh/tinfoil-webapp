import { ChatInput } from '@/components/chat/chat-input'
import { render, screen } from '@testing-library/react'
import { createRef, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/project', () => ({
  ProjectModeBanner: () => null,
  useProject: () => ({
    isProjectMode: false,
    activeProject: null,
    loadingProject: false,
  }),
}))

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}))

vi.mock('@/components/chat/hooks/use-chat-font', () => ({
  CHAT_FONT_CLASSES: { default: '' },
  useChatFont: () => 'default',
}))

// Visual viewport height with the on-screen keyboard open.
const VIEWPORT_HEIGHT_PX = 400
const TEXT_CONTENT_HEIGHT_PX = 1000

type ResizeEntry = { callback: () => void; targets: Set<Element> }
const resizeObservers = new Set<ResizeEntry>()

class FakeResizeObserver {
  private readonly entry: ResizeEntry

  constructor(callback: () => void) {
    this.entry = { callback, targets: new Set() }
    resizeObservers.add(this.entry)
  }

  observe(target: Element) {
    this.entry.targets.add(target)
  }

  unobserve(target: Element) {
    this.entry.targets.delete(target)
  }

  disconnect() {
    resizeObservers.delete(this.entry)
  }
}

function notifyResize(target: Element) {
  for (const { callback, targets } of [...resizeObservers]) {
    if (targets.has(target)) callback()
  }
}

const pendingFrames = new Map<number, FrameRequestCallback>()
let nextFrameId = 1

function flushFrames() {
  const callbacks = [...pendingFrames.values()]
  pendingFrames.clear()
  for (const callback of callbacks) callback(performance.now())
}

// Height of everything in the input area except the textarea.
let chromeHeight = 0

const textareaHeight = (textarea: HTMLTextAreaElement | null) =>
  Number.parseFloat(textarea?.style.height ?? '') || 0

beforeEach(() => {
  chromeHeight = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId++
    pendingFrames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    pendingFrames.delete(id)
  })
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: Object.assign(new EventTarget(), { height: VIEWPORT_HEIGHT_PX }),
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element) {
      const height =
        this instanceof HTMLTextAreaElement
          ? textareaHeight(this)
          : this.hasAttribute('data-chat-input-area')
            ? chromeHeight + textareaHeight(this.querySelector('textarea'))
            : 0
      return {
        height,
        width: 0,
        top: 0,
        left: 0,
        bottom: height,
        right: 0,
      } as DOMRect
    },
  )
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(
    function (this: Element) {
      return this instanceof HTMLTextAreaElement ? TEXT_CONTENT_HEIGHT_PX : 0
    },
  )
})

afterEach(() => {
  pendingFrames.clear()
  resizeObservers.clear()
  delete (window as { visualViewport?: VisualViewport }).visualViewport
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function ChatInputInArea(
  overrides: Partial<ComponentProps<typeof ChatInput>> = {},
) {
  return (
    <div data-chat-input-area>
      <ChatInput
        input="A long message that fills the text box"
        setInput={vi.fn()}
        handleSubmit={vi.fn()}
        loadingState="idle"
        cancelGeneration={vi.fn()}
        inputRef={createRef<HTMLTextAreaElement>()}
        handleInputFocus={vi.fn()}
        inputMinHeight="40px"
        isDarkMode
        hasMessages
        {...overrides}
      />
    </div>
  )
}

describe('ChatInput height cap', () => {
  it('shrinks the text box when an attachment grows the input area', () => {
    chromeHeight = 150
    const { container, rerender } = render(<ChatInputInArea />)
    flushFrames()
    const textarea = screen.getByRole('textbox')
    expect(textarea.style.height).toBe('226px')

    chromeHeight = 250
    rerender(
      <ChatInputInArea
        processedDocuments={[
          { id: 'photo-1', name: 'photo.png', time: new Date() },
        ]}
      />,
    )
    notifyResize(container.querySelector('[data-chat-input-area]')!)
    flushFrames()

    expect(textarea.style.height).toBe('126px')
  })
})
