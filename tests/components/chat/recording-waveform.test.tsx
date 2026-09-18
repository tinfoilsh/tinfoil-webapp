import { ChatInput } from '@/components/chat/chat-input'
import {
  RecordingWaveform,
  formatRecordingDuration,
} from '@/components/chat/recording-waveform'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('formatRecordingDuration', () => {
  it('renders minutes without padding and seconds zero-padded', () => {
    expect(formatRecordingDuration(0)).toBe('0:00')
    expect(formatRecordingDuration(9)).toBe('0:09')
    expect(formatRecordingDuration(59.9)).toBe('0:59')
    expect(formatRecordingDuration(60)).toBe('1:00')
    expect(formatRecordingDuration(605)).toBe('10:05')
  })

  it('clamps negative input to zero', () => {
    expect(formatRecordingDuration(-3)).toBe('0:00')
  })
})

function stubWebAudio() {
  const connect = vi.fn()
  const disconnect = vi.fn()
  const close = vi.fn(() => Promise.resolve())
  const createMediaStreamSource = vi.fn(() => ({ connect, disconnect }))
  const analyser = {
    fftSize: 2048,
    getByteTimeDomainData: vi.fn((buffer: Uint8Array) => buffer.fill(128)),
  }
  class FakeAudioContext {
    state = 'running'
    createMediaStreamSource = createMediaStreamSource
    createAnalyser = () => analyser
    close = close
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
  return { connect, disconnect, close, createMediaStreamSource, analyser }
}

describe('RecordingWaveform', () => {
  beforeEach(() => {
    // happy-dom has no 2D canvas; the component must cope with a null context
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => null,
    ) as unknown as HTMLCanvasElement['getContext']
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('feeds the microphone stream to an analyser and tears it down', () => {
    const audio = stubWebAudio()
    const stream = { getTracks: () => [] } as unknown as MediaStream

    const { unmount } = render(<RecordingWaveform stream={stream} />)

    expect(audio.createMediaStreamSource).toHaveBeenCalledWith(stream)
    expect(audio.connect).toHaveBeenCalledWith(audio.analyser)

    unmount()

    expect(audio.disconnect).toHaveBeenCalledOnce()
    expect(audio.close).toHaveBeenCalledOnce()
  })

  it('advances the elapsed timer once per second', () => {
    vi.useFakeTimers()
    stubWebAudio()
    const stream = { getTracks: () => [] } as unknown as MediaStream

    render(<RecordingWaveform stream={stream} />)
    expect(screen.getByTestId('recording-timer')).toHaveTextContent('0:00')

    act(() => {
      vi.advanceTimersByTime(9_100)
    })
    expect(screen.getByTestId('recording-timer')).toHaveTextContent('0:09')

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByTestId('recording-timer')).toHaveTextContent('1:09')
  })
})

describe('ChatInput recording UI', () => {
  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => null,
    ) as unknown as HTMLCanvasElement['getContext']
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('swaps the textarea for the waveform while recording and back on stop', async () => {
    stubWebAudio()
    const tracks = [{ stop: vi.fn() }]
    const stream = { getTracks: () => tracks } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(() => Promise.resolve(stream)) },
    })
    class FakeMediaRecorder {
      static isTypeSupported = () => true
      state: RecordingState = 'inactive'
      ondataavailable: ((event: BlobEvent) => void) | null = null
      onstop: (() => void) | null = null
      start() {
        this.state = 'recording'
      }
      stop() {
        this.state = 'inactive'
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)

    render(
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

    const textarea = screen.getByRole('textbox', { name: 'Message' })
    expect(screen.queryByTestId('recording-timer')).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    })

    expect(screen.getByTestId('recording-timer')).toBeInTheDocument()
    expect(textarea).toHaveClass('hidden')

    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))

    expect(screen.queryByTestId('recording-timer')).not.toBeInTheDocument()
    expect(textarea).not.toHaveClass('hidden')
  })
})
