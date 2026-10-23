import { DefaultMessageRenderer } from '@/components/chat/renderers/default/DefaultMessageRenderer'
import { SpeechProvider } from '@/components/chat/speech-context'
import type { Message, TimelineBlock } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import type {
  Annotation,
  ToolDisplay,
  Message as WireMessage,
} from '@/services/harness/types'
import { messageView } from '@/services/harness/view-model'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi, type Mock } from 'vitest'

const model = {
  id: 'current-model',
  label: 'Current Model',
  shortLabel: 'Current',
  icon: '',
  description: '',
  badges: [],
  reasoning: null,
  deprecated: false,
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
})

describe('DefaultMessageRenderer edit keyboard shortcuts', () => {
  const IPHONE_USER_AGENT =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  const messageIndex = 3

  describe.each<{
    name: string
    openEditor: (onSave: Mock) => HTMLElement
  }>([
    {
      name: 'user message',
      openEditor: (onSave) => {
        render(
          <Renderer
            message={{
              role: 'user',
              content: 'Original question',
              timestamp: new Date('2026-08-07T00:00:00.000Z'),
            }}
            messageIndex={messageIndex}
            model={model}
            isDarkMode={false}
            onEditMessage={onSave}
          />,
        )
        fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
        return screen.getByRole('textbox', { name: 'Edit message' })
      },
    },
    {
      name: 'assistant response',
      openEditor: (onSave) => {
        render(
          <Renderer
            message={{
              role: 'assistant',
              content: 'Original answer',
              timestamp: new Date('2026-08-07T00:00:01.000Z'),
              timeline: [
                {
                  type: 'content',
                  id: 'content-0',
                  content: 'Original answer',
                },
              ],
            }}
            messageIndex={messageIndex}
            model={model}
            isDarkMode={false}
            onEditAssistantMessage={onSave}
          />,
        )
        openMoreActions()
        fireEvent.click(screen.getByRole('menuitem', { name: 'Edit response' }))
        return screen.getByRole('textbox', { name: 'Edit response' })
      },
    },
  ])('$name editor', ({ openEditor }) => {
    const openEditorWithRevision = () => {
      const onSave = vi.fn()
      const textbox = openEditor(onSave)
      fireEvent.change(textbox, { target: { value: 'Revised text' } })
      return { onSave, textbox }
    }

    it('saves on plain Enter on desktop', () => {
      const { onSave, textbox } = openEditorWithRevision()

      fireEvent.keyDown(textbox, { key: 'Enter' })

      expect(onSave).toHaveBeenCalledExactlyOnceWith(
        messageIndex,
        'Revised text',
      )
      expect(textbox).not.toBeInTheDocument()
    })

    it('inserts a new line on plain Enter on phones', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE_USER_AGENT)
      const { onSave, textbox } = openEditorWithRevision()

      const notCancelled = fireEvent.keyDown(textbox, { key: 'Enter' })

      expect(notCancelled).toBe(true)
      expect(onSave).not.toHaveBeenCalled()
      expect(textbox).toBeInTheDocument()
      expect(textbox).toHaveValue('Revised text')
    })

    it('saves on Cmd+Enter on phones', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE_USER_AGENT)
      const { onSave, textbox } = openEditorWithRevision()

      fireEvent.keyDown(textbox, { key: 'Enter', metaKey: true })

      expect(onSave).toHaveBeenCalledExactlyOnceWith(
        messageIndex,
        'Revised text',
      )
      expect(textbox).not.toBeInTheDocument()
    })
  })
})

describe('DefaultMessageRenderer read aloud', () => {
  // A message of a chat the harness can read aloud.
  const renderSpoken = (
    message: Message,
    props: { isLastMessage?: boolean; isStreaming?: boolean } = {},
  ) =>
    render(
      <SpeechProvider speak={vi.fn()}>
        <Renderer
          message={{ id: 'reply-1', ...message }}
          messageIndex={0}
          model={model}
          isDarkMode={false}
          {...props}
        />
      </SpeechProvider>,
    )

  it('offers read aloud only on completed assistant responses', () => {
    renderSpoken({
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
    renderSpoken({ ...message, timestamp: new Date() })
    expect(
      screen.queryByRole('button', { name: 'Read aloud' }),
    ).not.toBeInTheDocument()
  })

  it.each([true, false])(
    'does not offer speech while a response is streaming (last=%s)',
    (isLastMessage) => {
      renderSpoken(
        { role: 'assistant', content: 'Partial.', timestamp: new Date() },
        { isLastMessage, isStreaming: true },
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

  // A reply that searched the web, as the harness streams and stores it.
  const searchReply = (
    display?: ToolDisplay,
    annotations?: Annotation[],
  ): WireMessage => ({
    id: 'a1',
    role: 'assistant',
    createdAt: '2026-08-07T00:00:01.000Z',
    timeline: [
      {
        id: 'call-1',
        type: 'tool_call',
        toolCallId: 'call-1',
        name: 'web_search',
        arguments: '{"query":"ignored"}',
        ...(display ? { display } : {}),
      },
      {
        id: 'c',
        type: 'content',
        content: 'See [Tinfoil](https://tinfoil.sh).',
      },
    ],
    ...(annotations ? { annotations } : {}),
  })
  const renderReply = (message: WireMessage, isStreaming: boolean) =>
    render(
      <Renderer
        message={messageView(message, isStreaming)}
        messageIndex={0}
        model={model}
        isDarkMode={false}
        isLastMessage
        isStreaming={isStreaming}
      />,
    )
  const source = { url: 'https://tinfoil.sh', title: 'Tinfoil' }

  it.each<{
    display?: ToolDisplay
    isStreaming: boolean
    label: string
  }>([
    {
      display: { query: 'tinfoil', status: 'completed', sources: [source] },
      isStreaming: false,
      label: 'Searched the web for "tinfoil"',
    },
    {
      display: { query: 'tinfoil', status: 'running', sources: [] },
      isStreaming: true,
      label: 'Searching the web...',
    },
    {
      display: { query: 'tinfoil', status: 'running', sources: [] },
      isStreaming: false,
      label: 'Search failed for "tinfoil"',
    },
    {
      display: { query: 'tinfoil', status: 'failed', sources: [] },
      isStreaming: false,
      label: 'Search failed for "tinfoil"',
    },
    { isStreaming: true, label: 'Searching the web...' },
    { isStreaming: false, label: 'Search failed' },
  ])(
    'shows a search as the harness reports it: $label',
    ({ display, isStreaming, label }) => {
      const { container } = renderReply(searchReply(display), isStreaming)
      expect(container).toHaveTextContent(label)
      expect(container).not.toHaveTextContent('ignored')
    },
  )

  it('offers to retry a widget whose stored arguments no longer match it', async () => {
    const onRetryToolCall = vi.fn(async () => true)
    const widgetReply = (invalidArguments?: boolean): WireMessage => ({
      id: 'a1',
      role: 'assistant',
      createdAt: '2026-08-07T00:00:01.000Z',
      timeline: [
        {
          id: 'call-1',
          type: 'tool_call',
          toolCallId: 'call-1',
          name: 'render_message_compose',
          arguments: JSON.stringify({
            channel: 'message',
            title: 'Reply draft',
            variants: [{ label: 'Concise', body: 'Thanks.' }],
          }),
          complete: true,
          ...(invalidArguments ? { invalidArguments } : {}),
        },
      ],
    })
    const view = (message: WireMessage) => (
      <Renderer
        message={messageView(message)}
        messageIndex={1}
        model={model}
        isDarkMode={false}
        isLastMessage
        onRetryToolCall={onRetryToolCall}
      />
    )
    const { rerender } = render(view(widgetReply()))
    expect(screen.getByText('Reply draft')).toBeInTheDocument()

    rerender(view(widgetReply(true)))

    expect(screen.queryByText('Reply draft')).not.toBeInTheDocument()
    expect(
      screen.getByText("Couldn't display message compose"),
    ).toBeInTheDocument()
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Retry widget' })),
    )
    expect(onRetryToolCall).toHaveBeenCalledExactlyOnceWith(1, 'call-1')
  })

  it('shows a link the reply cites as a citation', () => {
    renderReply(
      searchReply(
        { query: 'tinfoil', status: 'completed', sources: [source] },
        [{ type: 'url_citation', url_citation: source }],
      ),
      false,
    )

    expect(screen.getByRole('link', { name: 'tinfoil' })).toHaveAttribute(
      'href',
      'https://tinfoil.sh/',
    )
    expect(
      screen.queryByRole('link', { name: 'Tinfoil' }),
    ).not.toBeInTheDocument()
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
