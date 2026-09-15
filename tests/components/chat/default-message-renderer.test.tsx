import { DefaultMessageRenderer } from '@/components/chat/renderers/default/DefaultMessageRenderer'
import type { Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const model = {
  modelName: 'current-model',
  name: 'Current Model',
  nameShort: 'Current',
  image: '',
  description: '',
  type: 'chat',
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

  it('deletes a user message with its own index', () => {
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
    expect(onDeleteMessage).toHaveBeenCalledWith(4)
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

    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }))
    expect(onDeleteMessage).toHaveBeenCalledWith(3)
  })

  it('continues an assistant response without editing', () => {
    const onContinueAssistantMessage = vi.fn()
    render(
      <Renderer
        message={assistantMessage}
        messageIndex={3}
        model={model}
        isDarkMode={false}
        onContinueAssistantMessage={onContinueAssistantMessage}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Continue response' }))
    expect(onContinueAssistantMessage).toHaveBeenCalledWith(3)
  })

  it('saves an assistant edit without continuing', () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Edit response' }))
    const textarea = screen.getByRole('textbox', { name: 'Edit response' })
    fireEvent.change(textarea, { target: { value: 'Cleaned up answer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onEditAssistantMessage).toHaveBeenCalledWith(3, 'Cleaned up answer')
    expect(onContinueAssistantMessage).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('textbox', { name: 'Edit response' }),
    ).not.toBeInTheDocument()
  })

  it('saves an assistant edit and continues from it', () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Edit response' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit response' }), {
      target: { value: 'Cleaned up answer,' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }))

    expect(onContinueAssistantMessage).toHaveBeenCalledWith(
      3,
      'Cleaned up answer,',
    )
    expect(onEditAssistantMessage).not.toHaveBeenCalled()
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

    expect(
      screen.queryByRole('button', { name: 'Edit response' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Continue response' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Delete message' }),
    ).toBeInTheDocument()
  })
})
