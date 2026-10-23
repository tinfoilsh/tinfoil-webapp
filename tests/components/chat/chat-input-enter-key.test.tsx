import { ChatInput } from '@/components/chat/chat-input'
import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'

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

const IPHONE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

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

  it('inserts a new line on plain Enter on phones', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE_USER_AGENT)
    const { handleSubmit, textarea } = renderChatInput()

    const notCancelled = fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(notCancelled).toBe(true)
    expect(handleSubmit).not.toHaveBeenCalled()
  })

  it('submits on Cmd+Enter on phones', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE_USER_AGENT)
    const { handleSubmit, textarea } = renderChatInput()

    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })

    expect(handleSubmit).toHaveBeenCalledOnce()
  })

  it('keeps the text box focused after sending with the button on phones', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE_USER_AGENT)
    const { handleSubmit, textarea } = renderChatInput()
    expect(textarea).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(handleSubmit).toHaveBeenCalledOnce()
    expect(textarea).toHaveFocus()
  })

  it('blurs the text box after sending with the button on desktop', () => {
    const { handleSubmit, textarea } = renderChatInput()
    expect(textarea).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(handleSubmit).toHaveBeenCalledOnce()
    expect(textarea).not.toHaveFocus()
  })
})
