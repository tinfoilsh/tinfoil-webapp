import { ChatInput } from '@/components/chat/chat-input'
import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

function renderChatInput(handleSubmit = vi.fn()) {
  render(
    <ChatInput
      input="hello"
      setInput={vi.fn()}
      handleSubmit={handleSubmit}
      loadingState="idle"
      cancelGeneration={vi.fn()}
      inputRef={createRef<HTMLTextAreaElement>()}
      handleInputFocus={vi.fn()}
      inputMinHeight="40px"
      isDarkMode
    />,
  )
  return { handleSubmit, textarea: screen.getByRole('textbox') }
}

describe('ChatInput Enter key handling', () => {
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('submits on plain Enter', () => {
    const { handleSubmit, textarea } = renderChatInput()

    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(handleSubmit).toHaveBeenCalledOnce()
  })

  it('does not submit while an IME composition is active', () => {
    const { handleSubmit, textarea } = renderChatInput()

    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })

    expect(handleSubmit).not.toHaveBeenCalled()
  })

  it('does not submit on the IME process keyCode 229', () => {
    const { handleSubmit, textarea } = renderChatInput()

    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 })

    expect(handleSubmit).not.toHaveBeenCalled()
  })

  it('does not submit on Shift+Enter', () => {
    const { handleSubmit, textarea } = renderChatInput()

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

    expect(handleSubmit).not.toHaveBeenCalled()
  })
})
