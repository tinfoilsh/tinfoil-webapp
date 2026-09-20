import { ReadAloudButton } from '@/components/chat/renderers/components/ReadAloudButton'
import { speechPlayer } from '@/services/speech/player'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  controlledSpeech,
  FakeAudioContext,
} from '../../services/speech/fixtures'

const fakes = vi.hoisted(() => ({ stream: vi.fn(), context: vi.fn() }))
vi.mock('@/services/speech/player', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/services/speech/player')>()
  return {
    ...original,
    speechPlayer: new original.SpeechPlayer(fakes.stream, fakes.context),
  }
})

describe('read aloud button', () => {
  let generation: ReturnType<typeof controlledSpeech>
  let audio: FakeAudioContext
  beforeEach(() => {
    generation = controlledSpeech()
    audio = new FakeAudioContext()
    fakes.stream.mockImplementation(generation.stream)
    fakes.context.mockReturnValue(audio)
  })
  afterEach(() => act(() => speechPlayer.stop()))

  it('starts on click, exposes buffering and stop controls, and returns to idle', async () => {
    render(<ReadAloudButton content="Hello." />)
    expect(screen.getByRole('button', { name: 'Read aloud' })).not.toHaveClass(
      'animate-pulse',
      'text-red-600',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    expect(
      screen.getByRole('button', { name: 'Cancel read aloud' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Cancel read aloud' }),
    ).not.toHaveClass('animate-pulse', 'text-red-600')
    await waitFor(() => expect(generation.requests).toHaveLength(1))
    await act(async () => {
      generation.requests[0].push(2)
      generation.requests[0].finish()
    })
    const stopButton = screen.getByRole('button', {
      name: 'Stop reading aloud',
    })
    expect(stopButton).toHaveClass(
      'animate-pulse',
      'text-red-600',
      'dark:text-red-400',
      'motion-reduce:animate-none',
    )
    fireEvent.click(stopButton)
    expect(
      screen.getByRole('button', { name: 'Read aloud' }),
    ).toBeInTheDocument()
    expect(audio.close).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Read aloud' })).not.toHaveClass(
      'animate-pulse',
      'text-red-600',
    )
  })

  it('clears the red pulse when playback finishes naturally', async () => {
    render(<ReadAloudButton content="Hello." />)
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    await waitFor(() => expect(generation.requests).toHaveLength(1))
    await act(async () => {
      generation.requests[0].push(2)
      generation.requests[0].finish()
    })
    expect(
      screen.getByRole('button', { name: 'Stop reading aloud' }),
    ).toHaveClass('animate-pulse', 'text-red-600')
    act(() => audio.advanceTo(3))
    expect(screen.getByRole('button', { name: 'Read aloud' })).not.toHaveClass(
      'animate-pulse',
      'text-red-600',
    )
  })

  it('aborts pending generation when the message changes', async () => {
    const view = render(<ReadAloudButton content="Original." />)
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    await waitFor(() => expect(generation.requests).toHaveLength(1))
    view.rerender(<ReadAloudButton content="Edited." />)
    expect(generation.requests[0].signal.aborted).toBe(true)
    expect(
      screen.getByRole('button', { name: 'Read aloud' }),
    ).toBeInTheDocument()
  })

  it.each(['resume', 'stop'])(
    'can %s paused speech without generating it again',
    async (action) => {
      render(<ReadAloudButton content="Hello." />)
      fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
      await waitFor(() => expect(generation.requests).toHaveLength(1))
      await act(async () => {
        generation.requests[0].push(2)
        generation.requests[0].finish()
      })
      act(() => {
        audio.state = 'suspended'
        audio.onstatechange?.()
      })
      expect(screen.getByRole('status')).toHaveTextContent('Speech paused')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      if (action === 'resume') {
        fireEvent.click(
          screen.getByRole('button', { name: 'Resume reading aloud' }),
        )
        await waitFor(() =>
          expect(
            screen.getByRole('button', { name: 'Stop reading aloud' }),
          ).toHaveClass('animate-pulse'),
        )
        expect(audio.scheduled).toHaveLength(1)
      } else {
        fireEvent.click(
          screen.getByRole('button', { name: 'Stop reading aloud' }),
        )
        expect(
          screen.getByRole('button', { name: 'Read aloud' }),
        ).toBeInTheDocument()
        expect(audio.close).toHaveBeenCalledOnce()
      }
      expect(generation.requests).toHaveLength(1)
    },
  )

  it('aborts pending generation on unmount', async () => {
    const view = render(<ReadAloudButton content="Original." />)
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    await waitFor(() => expect(generation.requests).toHaveLength(1))
    view.unmount()
    expect(generation.requests[0].signal.aborted).toBe(true)
  })

  it('shows a safe error and allows another attempt', async () => {
    render(<ReadAloudButton content="Hello." />)
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    await waitFor(() => expect(generation.requests).toHaveLength(1))
    await act(async () => {
      generation.requests[0].fail(new Error('private response text'))
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not read this response aloud.',
    )
    expect(screen.getByRole('alert')).not.toHaveTextContent('private')
    fakes.context.mockReturnValue(new FakeAudioContext())
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    await waitFor(() => expect(generation.requests).toHaveLength(2))
  })
})
