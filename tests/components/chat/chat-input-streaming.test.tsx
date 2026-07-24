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

vi.mock('@/components/chat/hooks/use-chat-font', () => ({
  CHAT_FONT_CLASSES: { default: '' },
  useChatFont: () => 'default',
}))

describe('ChatInput streaming action', () => {
  it('shows Stop while a recovered response is streaming', () => {
    const cancelGeneration = vi.fn()
    render(
      <ChatInput
        input=""
        setInput={vi.fn()}
        handleSubmit={vi.fn()}
        loadingState="streaming"
        cancelGeneration={cancelGeneration}
        inputRef={createRef<HTMLTextAreaElement>()}
        handleInputFocus={vi.fn()}
        inputMinHeight="40px"
        isDarkMode
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }))

    expect(cancelGeneration).toHaveBeenCalledOnce()
    expect(
      screen.queryByRole('button', { name: 'Send' }),
    ).not.toBeInTheDocument()
  })
})
