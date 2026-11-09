import { ChatInput } from '@/components/chat/chat-input'
import { HarnessError } from '@/services/harness/sse'
import { dictation } from '@/services/speech/dictation'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { client, signIn, testSession } from '../../harness-fixture'
import { grantMicrophone, recording } from '../../services/speech/fixtures'

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
        chatId=""
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

  describe('dictation', () => {
    // A temporary chat keeps dictation off the device, so no recording one
    // test leaves reaches the next; keeping it is the dictation tests' to
    // check.
    const composer = (setInput: (value: string) => void, chatId = 'chat') => (
      <ChatInput
        chatId={chatId}
        isTemporaryMode
        input="Draft"
        setInput={setInput}
        handleSubmit={vi.fn()}
        loadingState="idle"
        cancelGeneration={vi.fn()}
        inputRef={createRef<HTMLTextAreaElement>()}
        handleInputFocus={vi.fn()}
        inputMinHeight="40px"
        isDarkMode
        isPremium
      />
    )
    const renderComposer = (setInput: (value: string) => void) =>
      render(composer(setInput))
    const segmentMs = testSession.composer.dictationSegmentSeconds * 1000

    beforeEach(() => {
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Date',
        ],
      })
      vi.stubGlobal('indexedDB', new IDBFactory())
      vi.stubGlobal('IDBKeyRange', FakeIDBKeyRange)
      signIn()
      grantMicrophone()
    })
    afterEach(() => {
      dictation.reset()
    })

    it('adds each recording to the draft as it is transcribed, while recording goes on', async () => {
      const answers = ['Hello there.', 'And more.']
      client.upload.mockImplementation(async () => ({
        text: answers.shift(),
      }))
      const setInput = vi.fn()
      renderComposer(setInput)

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
      })
      recording().hear('hello there')
      await act(() => vi.advanceTimersByTimeAsync(segmentMs))
      expect(setInput).toHaveBeenLastCalledWith('Draft Hello there.')
      expect(
        screen.getByRole('button', { name: 'Stop recording' }),
      ).toBeInTheDocument()

      recording().hear('and more')
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))
      })
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(setInput).toHaveBeenLastCalledWith('Draft Hello there. And more.')
      expect(
        screen.getByRole('button', { name: 'Start recording' }),
      ).toBeInTheDocument()
    })

    it('keeps recording when a composer that did not start it leaves', async () => {
      const { unmount: leaveHidden } = renderComposer(vi.fn())
      renderComposer(vi.fn())
      const [, shown] = screen.getAllByRole('button', {
        name: 'Start recording',
      })
      await act(async () => {
        fireEvent.click(shown)
      })
      leaveHidden()
      expect(
        screen.getByRole('button', { name: 'Stop recording' }),
      ).toBeInTheDocument()
      expect(recording().state).toBe('recording')
    })

    it('stops recording when the user moves to another chat, and keeps its text for the chat it was dictated in', async () => {
      client.upload.mockResolvedValueOnce({ text: 'Mine.' })
      const setInput = vi.fn()
      const { rerender } = render(composer(setInput))

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
      })
      const recorder = recording()
      recorder.hear('mine')
      rerender(composer(setInput, 'another chat'))
      expect(recorder.state).toBe('inactive')
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(client.upload).toHaveBeenCalledOnce()
      expect(setInput).not.toHaveBeenCalled()

      rerender(composer(setInput))
      expect(setInput).toHaveBeenLastCalledWith('Draft Mine.')
    })

    it('keeps a recording that could not be transcribed for the user to try again', async () => {
      client.upload.mockRejectedValueOnce(
        new HarnessError(
          {
            code: 'ATTACHMENT_UNSUPPORTED',
            action: 'revise',
            message: 'Unsupported recording type',
          },
          415,
        ),
      )
      client.upload.mockResolvedValueOnce({ text: 'Kept.' })
      const setInput = vi.fn()
      renderComposer(setInput)

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
      })
      recording().hear('kept')
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))
      })
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(
        screen.getByText(/Couldn't transcribe part of your dictation/),
      ).toBeInTheDocument()
      expect(setInput).not.toHaveBeenCalled()

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      })
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(setInput).toHaveBeenLastCalledWith('Draft Kept.')
      expect(
        screen.queryByRole('button', { name: 'Try again' }),
      ).not.toBeInTheDocument()
    })
  })

  it('shows Stop while a recovered response is streaming', () => {
    const cancelGeneration = vi.fn()
    const props = {
      chatId: '',
      input: '',
      setInput: vi.fn(),
      handleSubmit: vi.fn(),
      cancelGeneration,
      inputRef: createRef<HTMLTextAreaElement>(),
      handleInputFocus: vi.fn(),
      inputMinHeight: '40px',
      isDarkMode: true,
    }
    const { rerender } = render(
      <ChatInput {...props} loadingState="streaming" />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }))

    expect(cancelGeneration).toHaveBeenCalledOnce()
    expect(
      screen.queryByRole('button', { name: 'Send' }),
    ).not.toBeInTheDocument()

    rerender(<ChatInput {...props} loadingState="idle" />)

    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Stop generation' }),
    ).not.toBeInTheDocument()
  })
})
