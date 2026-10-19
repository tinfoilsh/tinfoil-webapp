import { DefaultMessageRenderer } from '@/components/chat/renderers/default/DefaultMessageRenderer'
import type { Message, TimelineBlock } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
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

const openMoreActions = () =>
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }))

const getDeleteConfirmation = (title: string) =>
  screen.getByRole('alertdialog', { name: title })

const confirmDelete = (title: string) =>
  fireEvent.click(
    within(getDeleteConfirmation(title)).getByRole('button', {
      name: 'Delete',
    }),
  )

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
    const message: Message = {
      role: 'assistant',
      content: 'Hello',
      modelDisplayName: 'Retired Model',
      timestamp: new Date('2026-08-07T00:00:01.000Z'),
    }
    const { rerender } = renderMessage(message)

    expect(screen.getByText('Retired Model')).toBeInTheDocument()
    expect(screen.getByText('Encrypted')).toBeInTheDocument()
    expect(screen.queryByText('Current Model')).not.toBeInTheDocument()

    rerender(
      <Renderer
        message={{ ...message, modelDisplayName: undefined }}
        messageIndex={0}
        model={model}
        isDarkMode={false}
      />,
    )
    expect(screen.getByText('Encrypted')).toBeInTheDocument()
    expect(screen.queryByText('Current Model')).not.toBeInTheDocument()
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
      screen.queryByRole('button', { name: 'Read aloud' }),
    ).not.toBeInTheDocument()
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
      const onDeleteMessage = vi.fn()
      const onForkMessage = vi.fn()
      const onRegenerateMessage = vi.fn()
      const onEditMessage = vi.fn()
      const props = {
        message,
        messageIndex,
        model,
        isDarkMode: false,
        onDeleteMessage,
        onForkMessage,
        onRegenerateMessage,
        onEditMessage,
      }
      const { container, rerender } = render(<Renderer {...props} />)

      expect(screen.getByRole('button', { name: 'Edit message' })).toBeVisible()
      expect(
        screen.queryByRole('button', { name: 'Copy message' }),
      ).not.toBeInTheDocument()
      expect(container.querySelector('.prose')).not.toBeInTheDocument()
      for (const [name, handler] of [
        ['Fork conversation from here', onForkMessage],
        ['Regenerate response', onRegenerateMessage],
      ] as const) {
        fireEvent.click(screen.getByRole('button', { name }))
        expect(handler).toHaveBeenCalledWith(messageIndex)
      }
      fireEvent.click(screen.getByRole('button', { name: 'Delete message' }))
      expect(onDeleteMessage).not.toHaveBeenCalled()
      confirmDelete('Delete message?')
      expect(onDeleteMessage).toHaveBeenCalledExactlyOnceWith(messageIndex)
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()

      rerender(<Renderer {...props} hideActions />)
      for (const name of [
        'Edit message',
        'Delete message',
        'Fork conversation from here',
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
        onDeleteMessage={vi.fn()}
        onForkMessage={vi.fn()}
        onRegenerateMessage={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('does not delete a user message when the confirmation is cancelled', () => {
    const onDeleteMessage = vi.fn()
    render(
      <Renderer
        message={{
          role: 'user',
          content: 'Hello',
          timestamp: new Date('2026-08-07T00:00:00.000Z'),
        }}
        messageIndex={4}
        model={model}
        isDarkMode={false}
        onDeleteMessage={onDeleteMessage}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }))
    fireEvent.click(
      within(getDeleteConfirmation('Delete message?')).getByRole('button', {
        name: 'Cancel',
      }),
    )
    expect(onDeleteMessage).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete message' })).toBeVisible()
  })

  it('closes a pending delete confirmation when the conversation becomes read-only', () => {
    const onDeleteMessage = vi.fn()
    const props = {
      message: {
        role: 'user' as const,
        content: 'Hello',
        timestamp: new Date('2026-08-07T00:00:00.000Z'),
      },
      messageIndex: 0,
      model,
      isDarkMode: false,
      onDeleteMessage,
    }
    const { rerender } = render(<Renderer {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }))
    expect(getDeleteConfirmation('Delete message?')).toBeInTheDocument()

    rerender(<Renderer {...props} hideActions />)

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(onDeleteMessage).not.toHaveBeenCalled()
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

  it('deletes an assistant message with its own index', () => {
    const onDeleteMessage = vi.fn()
    render(
      <Renderer
        message={assistantMessage}
        messageIndex={3}
        model={model}
        isDarkMode={false}
        onDeleteMessage={onDeleteMessage}
      />,
    )

    openMoreActions()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete message' }))
    expect(onDeleteMessage).not.toHaveBeenCalled()
    confirmDelete('Delete response?')
    expect(onDeleteMessage).toHaveBeenCalledExactlyOnceWith(3)
  })

  it('saves an assistant edit in place', () => {
    const onEditAssistantMessage = vi.fn()
    const onContinueAssistantMessage = vi.fn()
    render(
      <Renderer
        message={assistantMessage}
        messageIndex={3}
        model={model}
        isDarkMode={false}
        onEditAssistantMessage={onEditAssistantMessage}
        onContinueAssistantMessage={onContinueAssistantMessage}
      />,
    )

    openMoreActions()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit response' }))
    const textarea = screen.getByRole('textbox', { name: 'Edit response' })
    fireEvent.change(textarea, { target: { value: 'Cleaned up answer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onEditAssistantMessage).toHaveBeenCalledWith(3, 'Cleaned up answer')
    expect(onContinueAssistantMessage).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('textbox', { name: 'Edit response' }),
    ).not.toBeInTheDocument()
  })

  it('returns focus to the more menu trigger after cancelling an edit', () => {
    vi.useFakeTimers()
    try {
      render(
        <Renderer
          message={assistantMessage}
          messageIndex={3}
          model={model}
          isDarkMode={false}
          onEditAssistantMessage={vi.fn()}
        />,
      )

      openMoreActions()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit response' }))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      act(() => {
        vi.runAllTimers()
      })

      expect(screen.getByRole('button', { name: 'More actions' })).toHaveFocus()
    } finally {
      vi.useRealTimers()
    }
  })

  it('supports arrow key navigation and tab dismissal in the more menu', () => {
    render(
      <Renderer
        message={assistantMessage}
        messageIndex={3}
        model={model}
        isDarkMode={false}
        onEditAssistantMessage={vi.fn()}
        onDeleteMessage={vi.fn()}
      />,
    )

    openMoreActions()
    const editItem = screen.getByRole('menuitem', { name: 'Edit response' })
    const deleteItem = screen.getByRole('menuitem', { name: 'Delete message' })
    editItem.focus()

    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(deleteItem).toHaveFocus()
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(editItem).toHaveFocus()
    fireEvent.keyDown(document, { key: 'ArrowUp' })
    expect(deleteItem).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('does not offer edit or continue on rate limit errors', () => {
    render(
      <Renderer
        message={{
          role: 'assistant',
          content: 'Error: limit',
          isError: true,
          isRateLimitError: true,
          timestamp: new Date('2026-08-07T00:00:01.000Z'),
        }}
        messageIndex={1}
        model={model}
        isDarkMode={false}
        onEditAssistantMessage={vi.fn()}
        onContinueAssistantMessage={vi.fn()}
        onDeleteMessage={vi.fn()}
      />,
    )

    openMoreActions()
    expect(
      screen.queryByRole('menuitem', { name: 'Edit response' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('menuitem', { name: 'Continue response' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: 'Delete message' }),
    ).toBeInTheDocument()
  })
})

describe('DefaultMessageRenderer read aloud', () => {
  it('offers read aloud only on completed assistant responses', () => {
    renderMessage({
      role: 'assistant',
      content: 'Hello.',
      timestamp: new Date(),
    })
    expect(
      screen.getByRole('button', { name: 'Read aloud' }),
    ).toBeInTheDocument()
  })

  it.each([
    { role: 'user' as const, content: 'Hello.' },
    { role: 'assistant' as const, content: '' },
    { role: 'assistant' as const, content: 'Error.', isError: true },
    { role: 'assistant' as const, content: 'Thinking.', isThinking: true },
  ])('does not offer read aloud for $role / $content', (message) => {
    renderMessage({ ...message, timestamp: new Date() })
    expect(
      screen.queryByRole('button', { name: 'Read aloud' }),
    ).not.toBeInTheDocument()
  })

  it.each([true, false])(
    'does not offer speech while a response is streaming (last=%s)',
    (isLastMessage) => {
      render(
        <Renderer
          message={{
            role: 'assistant',
            content: 'Partial.',
            timestamp: new Date(),
          }}
          messageIndex={0}
          model={model}
          isDarkMode={false}
          isLastMessage={isLastMessage}
          isStreaming
        />,
      )
      expect(
        screen.queryByRole('button', { name: 'Read aloud' }),
      ).not.toBeInTheDocument()
    },
  )
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

  it.each([
    { isStreaming: true, label: 'Searching the web...' },
    { isStreaming: false, label: 'Search failed for "tinfoil"' },
  ])(
    'shows a search without a result while streaming=$isStreaming as $label',
    ({ isStreaming, label }) => {
      const { container } = render(
        <Renderer
          message={{
            role: 'assistant',
            content: '',
            timestamp: new Date('2026-08-07T00:00:01.000Z'),
            timeline: [
              {
                type: 'tool_call',
                id: 'call-1',
                toolCallId: 'call-1',
                name: 'web_search',
                arguments: '{"query":"tinfoil"}',
              },
            ],
          }}
          messageIndex={0}
          model={model}
          isDarkMode={false}
          isLastMessage
          isStreaming={isStreaming}
        />,
      )
      expect(container).toHaveTextContent(label)
      expect(container).not.toHaveTextContent('Searched the web')
    },
  )

  it('shows a search the model called with null arguments as failed', () => {
    const { container } = render(
      <Renderer
        message={{
          role: 'assistant',
          content: '',
          timestamp: new Date('2026-08-07T00:00:01.000Z'),
          timeline: [
            {
              type: 'tool_call',
              id: 'call-1',
              toolCallId: 'call-1',
              name: 'web_search',
              arguments: 'null',
              result: { error: 'A search query is required' },
            },
          ],
        }}
        messageIndex={0}
        model={model}
        isDarkMode={false}
        isLastMessage
      />,
    )
    expect(container).toHaveTextContent('Search failed')
    expect(container).not.toHaveTextContent('Search failed for')
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
