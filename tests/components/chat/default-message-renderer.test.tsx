import { DefaultMessageRenderer } from '@/components/chat/renderers/default/DefaultMessageRenderer'
import type { Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

const model = {
  modelName: 'current-model',
  name: 'Current Model',
  nameShort: 'Current',
  image: '',
  description: '',
  type: 'chat',
} satisfies BaseModel

const Renderer = DefaultMessageRenderer.render

const renderMessage = (message: Message) =>
  render(
    <Renderer
      message={message}
      messageIndex={0}
      model={model}
      isDarkMode={false}
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
})
