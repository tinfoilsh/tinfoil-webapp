import { DefaultMessageRenderer } from '@/components/chat/renderers/default/DefaultMessageRenderer'
import type { Message, TimelineBlock } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import {
  fireEvent,
  isInaccessible,
  render,
  screen,
} from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const model = {
  modelName: 'current-model',
  name: 'Current Model',
  nameShort: 'Current',
  image: '',
  description: '',
  type: 'chat',
  chat: true,
} satisfies BaseModel

const Renderer = DefaultMessageRenderer.render

const renderMessage = (message: Message, hideActions = false) =>
  render(
    <Renderer
      message={message}
      messageIndex={0}
      model={model}
      isDarkMode={false}
      hideActions={hideActions}
    />,
  )

describe('DefaultMessageRenderer streaming completion', () => {
  it('preserves rendered content and table scroll position when a response finishes', () => {
    const content =
      '| First column | Second column |\n| --- | --- |\n| First value | Second value |\n\nThe response continues after the table.'
    const message: Message = {
      role: 'assistant',
      content,
      timestamp: new Date('2026-10-12T00:00:00.000Z'),
      timeline: [{ type: 'content', id: 'answer', content }],
    }
    const view = (isStreaming: boolean) => (
      <Renderer
        message={message}
        messageIndex={1}
        model={model}
        isDarkMode={false}
        isLastMessage
        isStreaming={isStreaming}
      />
    )
    const { rerender } = render(view(true))
    const table = screen.getByRole('group', {
      name: 'Table, scroll horizontally to see more',
    })
    const tableScrollLeft = 120
    table.scrollLeft = tableScrollLeft
    const paragraph = screen.getByText(
      'The response continues after the table.',
    )

    rerender(view(false))

    expect(screen.getByText('The response continues after the table.')).toBe(
      paragraph,
    )
    expect(
      screen.getByRole('group', {
        name: 'Table, scroll horizontally to see more',
      }),
    ).toBe(table)
    expect(table.scrollLeft).toBe(tableScrollLeft)
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeVisible()
  })
})

describe('DefaultMessageRenderer metadata', () => {
  it('does not show assistant metadata on user messages', () => {
    renderMessage({
      role: 'user',
      content: 'Hello',
      timestamp: new Date('2026-08-07T00:00:00.000Z'),
    })

    expect(screen.queryByText('Encrypted')).not.toBeInTheDocument()
    expect(screen.queryByText('Current Model')).not.toBeInTheDocument()
  })

  it('shows the persisted model name and encrypted under responses', () => {
    renderMessage({
      role: 'assistant',
      content: 'Hello',
      modelDisplayName: 'Retired Model',
      timestamp: new Date('2026-08-07T00:00:01.000Z'),
    })

    expect(screen.getByText('Retired Model')).toBeInTheDocument()
    expect(screen.getByText('Encrypted')).toBeInTheDocument()
    expect(screen.queryByText('Current Model')).not.toBeInTheDocument()
    expect(
      screen.getByText('Retired Model').parentElement?.parentElement,
    ).toHaveClass('flex-col', 'md:flex-row-reverse')
    expect(
      screen.getByText('Retired Model').parentElement?.parentElement,
    ).toContainElement(screen.getByRole('button', { name: 'Copy message' }))
  })

  it('does not attribute legacy responses to the current model', () => {
    renderMessage({
      role: 'assistant',
      content: 'Hello',
      timestamp: new Date('2026-08-07T00:00:01.000Z'),
    })

    expect(screen.queryByText('Current Model')).not.toBeInTheDocument()
    expect(screen.getByText('Encrypted')).toBeInTheDocument()
  })

  it('does not show metadata for an empty cancelled response', () => {
    renderMessage({
      role: 'assistant',
      content: '',
      modelDisplayName: 'Retired Model',
      timestamp: new Date('2026-08-07T00:00:01.000Z'),
    })

    expect(screen.queryByText('Retired Model')).not.toBeInTheDocument()
    expect(screen.queryByText('Encrypted')).not.toBeInTheDocument()
  })

  it('hides user actions but preserves the date in read-only conversations', () => {
    render(
      <Renderer
        message={{
          role: 'user',
          content: 'Hello',
          timestamp: new Date('2026-08-07T00:00:00.000Z'),
        }}
        messageIndex={0}
        model={model}
        isDarkMode={false}
        hideActions
        onEditMessage={vi.fn()}
        onRegenerateMessage={vi.fn()}
      />,
    )

    for (const name of [
      'Copy message',
      'Edit message',
      'Regenerate response',
    ]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
    expect(
      screen.getByText(
        new Date('2026-08-07T00:00:00.000Z').toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        }),
      ),
    ).toBeInTheDocument()
  })

  it('shows response metadata when actions are hidden', () => {
    renderMessage(
      {
        role: 'assistant',
        content: 'Hello',
        modelDisplayName: 'Retired Model',
        timestamp: new Date('2026-08-07T00:00:01.000Z'),
      },
      true,
    )

    expect(screen.getByText('Retired Model')).toBeInTheDocument()
    expect(screen.getByText('Encrypted')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Copy message' }),
    ).not.toBeInTheDocument()
  })
})

describe('DefaultMessageRenderer message actions', () => {
  const assistantMessage: Message = {
    role: 'assistant',
    content: 'Half of an answer',
    timestamp: new Date('2026-08-07T00:00:01.000Z'),
    timeline: [
      { type: 'content', id: 'content-0', content: 'Half of an answer' },
    ],
  }

  describe.each<{ name: string; attachmentFields: Partial<Message> }>([
    {
      name: 'document',
      attachmentFields: {
        attachments: [
          {
            id: 'document-1',
            type: 'document',
            fileName: 'notes.txt',
            textContent: 'Meeting notes',
          },
        ],
      },
    },
    {
      name: 'image',
      attachmentFields: {
        attachments: [
          {
            id: 'image-1',
            type: 'image',
            fileName: 'photo.png',
            mimeType: 'image/png',
            base64: 'aW1hZ2U=',
          },
        ],
      },
    },
    {
      name: 'legacy document',
      attachmentFields: { documents: [{ name: 'notes.txt' }] },
    },
    {
      name: 'legacy image',
      attachmentFields: {
        imageData: [{ base64: 'aW1hZ2U=', mimeType: 'image/png' }],
      },
    },
  ])('$name-only messages', ({ attachmentFields }) => {
    const message: Message = {
      role: 'user',
      content: '',
      timestamp: new Date('2026-08-07T00:00:00.000Z'),
      ...attachmentFields,
    }

    it('offers message actions without a text bubble or copy button', () => {
      const messageIndex = 2
      const onRegenerateMessage = vi.fn()
      const onEditMessage = vi.fn()
      const props = {
        message,
        messageIndex,
        model,
        isDarkMode: false,
        onRegenerateMessage,
        onEditMessage,
      }
      const { container, rerender } = render(<Renderer {...props} />)

      expect(screen.getByRole('button', { name: 'Edit message' })).toBeVisible()
      expect(
        screen.queryByRole('button', { name: 'Copy message' }),
      ).not.toBeInTheDocument()
      expect(container.querySelector('.prose')).not.toBeInTheDocument()
      fireEvent.click(
        screen.getByRole('button', { name: 'Regenerate response' }),
      )
      expect(onRegenerateMessage).toHaveBeenCalledExactlyOnceWith(messageIndex)

      rerender(<Renderer {...props} hideActions />)
      for (const name of [
        'Edit message',
        'Regenerate response',
        'Copy message',
      ]) {
        expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
      }
      expect(
        screen.getByText(
          message.timestamp.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
          }),
        ),
      ).toBeVisible()
    })

    it('lets the user cancel editing or add text to the prompt', () => {
      const messageIndex = 2
      const onEditMessage = vi.fn()
      render(
        <Renderer
          message={message}
          messageIndex={messageIndex}
          model={model}
          isDarkMode={false}
          onEditMessage={onEditMessage}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
      expect(screen.getByRole('textbox', { name: 'Edit message' })).toHaveValue(
        '',
      )
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onEditMessage).not.toHaveBeenCalled()
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), {
        target: { value: '  Summarize this attachment  ' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(onEditMessage).toHaveBeenCalledWith(
        messageIndex,
        'Summarize this attachment',
      )
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    it('keeps the copy button when the attachment has accompanying text', () => {
      renderMessage({ ...message, content: 'Summarize this attachment' })
      expect(screen.getByRole('button', { name: 'Copy message' })).toBeVisible()
      expect(screen.getByText('Summarize this attachment')).toBeVisible()
    })
  })

  it('does not show actions for a message without text or attachments', () => {
    render(
      <Renderer
        message={{
          role: 'user',
          content: '',
          timestamp: new Date(),
          attachments: [],
        }}
        messageIndex={0}
        model={model}
        isDarkMode={false}
        onEditMessage={vi.fn()}
        onRegenerateMessage={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('closes an active edit when the conversation becomes read-only', () => {
    const message: Message = {
      role: 'user',
      content: 'Hello',
      timestamp: new Date('2026-08-07T00:00:00.000Z'),
    }
    const props = {
      message,
      messageIndex: 0,
      model,
      isDarkMode: false,
      onEditMessage: vi.fn(),
    }
    const { rerender } = render(<Renderer {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()

    rerender(<Renderer {...props} hideActions />)

    expect(
      screen.queryByRole('button', { name: 'Save' }),
    ).not.toBeInTheDocument()
  })

  it('names each action once for screen readers, not again as its hover tooltip', () => {
    const { unmount } = render(
      <Renderer
        message={{
          role: 'user',
          content: 'Hello',
          timestamp: new Date('2026-08-07T00:00:00.000Z'),
        }}
        messageIndex={2}
        model={model}
        isDarkMode={false}
        onRegenerateMessage={vi.fn()}
        onEditMessage={vi.fn()}
      />,
    )
    for (const [button, tooltip] of [
      ['Regenerate response', 'Regenerate'],
      ['Edit message', 'Edit'],
      ['Copy message', 'Copy'],
    ] as const) {
      expect(screen.getByRole('button', { name: button })).toBeVisible()
      expect(isInaccessible(screen.getByText(tooltip))).toBe(true)
    }
    unmount()

    render(
      <Renderer
        message={assistantMessage}
        messageIndex={3}
        model={model}
        isDarkMode={false}
        isLastMessage
        onRegenerateMessage={vi.fn()}
      />,
    )
    for (const [button, tooltip] of [
      ['Copy message', 'Copy'],
      ['Regenerate response', 'Regenerate'],
    ] as const) {
      expect(screen.getByRole('button', { name: button })).toBeVisible()
      expect(isInaccessible(screen.getByText(tooltip))).toBe(true)
    }
  })
})

describe('DefaultMessageRenderer work traces', () => {
  const traceTimeline: TimelineBlock[] = [
    {
      type: 'thinking',
      id: 'thinking-0',
      content: 'Plan the searches.',
      isThinking: false,
      duration: 4.7,
      startedAt: 0,
      endedAt: 4_700,
    },
    {
      type: 'web_search',
      id: 'web-search-1',
      state: { query: 'first', status: 'completed', sources: [] },
      startedAt: 4_700,
      endedAt: 20_000,
    },
    // Stray newline the model emitted between tool calls.
    { type: 'content', id: 'content-2', content: '\n\n' },
    {
      type: 'web_search',
      id: 'web-search-3',
      state: { query: 'second', status: 'completed', sources: [] },
      startedAt: 20_000,
      endedAt: 42_000,
    },
    { type: 'content', id: 'content-4', content: 'Final answer.' },
  ]

  it('collapses a finished run into one "Worked for" row with no phantom gap', () => {
    const { container } = renderMessage({
      role: 'assistant',
      content: 'Final answer.',
      timestamp: new Date('2026-08-07T00:00:01.000Z'),
      timeline: traceTimeline,
    })

    const header = screen.getByText('Worked').closest('button')!
    expect(header).toHaveTextContent('Worked for 42.0 seconds')
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Thought')).toBeInTheDocument()
    expect(screen.getAllByText('Searched the web')).toHaveLength(2)
    expect(screen.getByText('Final answer.')).toBeInTheDocument()

    // The work group and the answer are adjacent siblings: the
    // whitespace-only content block must not render a py-2 spacer.
    const groupWrapper = header.closest('.no-scroll-anchoring')!
    const answerWrapper = screen.getByText('Final answer.').closest('.py-2')!
    expect(groupWrapper.nextElementSibling).toBe(answerWrapper)
    expect(container.querySelectorAll('.w-full.px-4.py-2')).toHaveLength(1)
  })

  it('shows the live action in the header while the last run is streaming', () => {
    render(
      <Renderer
        message={{
          role: 'assistant',
          content: '',
          timestamp: new Date('2026-08-07T00:00:01.000Z'),
          timeline: [
            traceTimeline[0],
            traceTimeline[1],
            {
              type: 'web_search',
              id: 'web-search-2',
              state: { query: 'second', status: 'searching' },
              startedAt: 20_000,
            },
          ],
        }}
        messageIndex={0}
        model={model}
        isDarkMode={false}
        isLastMessage
        isStreaming
      />,
    )
    expect(
      screen.getByText('Searching the web for "second"').closest('button'),
    ).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/Worked/)).not.toBeInTheDocument()
  })

  it('does not treat an earlier run as active when answer text follows it', () => {
    render(
      <Renderer
        message={{
          role: 'assistant',
          content: 'Partial',
          timestamp: new Date('2026-08-07T00:00:01.000Z'),
          timeline: [
            ...traceTimeline.slice(0, 4),
            {
              type: 'content',
              id: 'content-4',
              content: 'Partial',
            },
          ],
        }}
        messageIndex={0}
        model={model}
        isDarkMode={false}
        isLastMessage
        isStreaming
      />,
    )
    expect(screen.getByText('Worked').closest('button')).toHaveTextContent(
      'Worked for 42.0 seconds',
    )
  })

  it('leaves a lone trace block rendered as itself', () => {
    renderMessage({
      role: 'assistant',
      content: 'Answer',
      timestamp: new Date('2026-08-07T00:00:01.000Z'),
      timeline: [
        traceTimeline[0],
        { type: 'content', id: 'c', content: 'Answer' },
      ],
    })
    expect(screen.getByText('Thought')).toBeInTheDocument()
    expect(screen.getByText('for 4.7 seconds')).toBeInTheDocument()
    expect(screen.queryByText(/Worked/)).not.toBeInTheDocument()
  })
})
