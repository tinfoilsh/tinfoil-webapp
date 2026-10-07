import { ChatInput } from '@/components/chat/chat-input'
import { act, fireEvent, render, screen } from '@testing-library/react'
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

vi.mock('@/components/chat/hooks/use-chat-font', () => ({
  CHAT_FONT_CLASSES: { default: '' },
  useChatFont: () => 'default',
}))

describe('ChatInput streaming action', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('stops a microphone stream granted after unmount', async () => {
    vi.useFakeTimers()
    let grantPermission!: (stream: MediaStream) => void
    const stop = vi.fn()
    const constructRecorder = vi.fn()
    const start = vi.fn()
    class SupportedMediaRecorder {
      static isTypeSupported = () => true
      start = start
      constructor(stream: MediaStream) {
        constructRecorder(stream)
      }
    }
    vi.stubGlobal('MediaRecorder', SupportedMediaRecorder)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>((resolve) => {
              grantPermission = resolve
            }),
        ),
      },
    })
    const { unmount } = render(
      <ChatInput
        input=""
        setInput={vi.fn()}
        handleSubmit={vi.fn()}
        loadingState="idle"
        cancelGeneration={vi.fn()}
        inputRef={createRef<HTMLTextAreaElement>()}
        handleInputFocus={vi.fn()}
        inputMinHeight="40px"
        isDarkMode
        isPremium
        audioModel="audio-model"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    unmount()

    await act(async () => {
      grantPermission({
        getTracks: () => [{ stop }],
      } as unknown as MediaStream)
    })

    expect(stop).toHaveBeenCalledOnce()
    expect(constructRecorder).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

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

  it('returns to the Send action as soon as cancellation is reflected', () => {
    const props = {
      input: '',
      setInput: vi.fn(),
      handleSubmit: vi.fn(),
      cancelGeneration: vi.fn(),
      inputRef: createRef<HTMLTextAreaElement>(),
      handleInputFocus: vi.fn(),
      inputMinHeight: '40px',
      isDarkMode: true,
    }
    const { rerender } = render(
      <ChatInput {...props} loadingState="streaming" />,
    )

    rerender(<ChatInput {...props} loadingState="idle" />)

    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Stop generation' }),
    ).not.toBeInTheDocument()
  })
})
