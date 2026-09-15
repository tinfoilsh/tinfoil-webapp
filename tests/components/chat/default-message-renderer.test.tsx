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

describe('regenerating a response', () => {
  it.each([
    { role: 'user' as const, index: 0, assistantIndex: 1 },
    { role: 'assistant' as const, index: 1, assistantIndex: 1 },
    { role: 'assistant' as const, index: 0, assistantIndex: 0 },
  ])(
    'targets the assistant from the $role control at index $index',
    ({ role, index, assistantIndex }) => {
      const regenerate = vi.fn()
      render(
        <Renderer
          message={{ role, content: 'Hello', timestamp: new Date() }}
          messageIndex={index}
          model={model}
          isDarkMode={false}
          isLastMessage={role === 'assistant'}
          onRegenerateMessage={regenerate}
        />,
      )

      fireEvent.click(
        screen.getByRole('button', { name: 'Regenerate response' }),
      )

      expect(regenerate).toHaveBeenCalledExactlyOnceWith(assistantIndex)
    },
  )

  it('does not offer regeneration before an assistant response exists', () => {
    render(
      <Renderer
        message={{ role: 'user', content: 'Hello', timestamp: new Date() }}
        messageIndex={0}
        model={model}
        isDarkMode={false}
        isLastMessage
        onRegenerateMessage={vi.fn()}
      />,
    )

    expect(
      screen.queryByRole('button', { name: 'Regenerate response' }),
    ).not.toBeInTheDocument()
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
