import { ReadAloudButton } from '@/components/chat/renderers/components/ReadAloudButton'
import { SpeechProvider } from '@/components/chat/speech-context'
import { publish } from '@/services/harness/runtime'
import { speechPlayer } from '@/services/speech/player'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { client, signIn, testSession } from '../../harness-fixture'
import {
  controlledSpeak,
  FakeAudioContext,
} from '../../services/speech/fixtures'

const fakes = vi.hoisted(() => ({ context: vi.fn() }))
vi.mock('@/services/speech/player', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/services/speech/player')>()
  return {
    ...original,
    speechPlayer: new original.SpeechPlayer(fakes.context),
  }
})

describe('read aloud button', () => {
  let speech: ReturnType<typeof controlledSpeak>
  let audio: FakeAudioContext
  beforeEach(() => {
    speech = controlledSpeak()
    audio = new FakeAudioContext()
    fakes.context.mockReset().mockReturnValue(audio)
  })
  afterEach(() => act(() => speechPlayer.stop()))

  const button = (content = 'Hello.') => (
    <SpeechProvider speak={speech.speak}>
      <ReadAloudButton messageId="reply-1" content={content} />
    </SpeechProvider>
  )

  it('is not offered by a harness without speech', () => {
    publish({
      session: {
        ...testSession,
        features: { ...testSession.features, speech: false },
      },
    })
    const { container } = render(button())
    expect(container).toBeEmptyDOMElement()
  })

  it('is offered while the session loads, and stays in place once the session offers speech', () => {
    publish({ session: undefined })
    render(button())
    const offered = screen.getByRole('button', { name: 'Read aloud' })

    act(() => publish({ session: testSession }))

    expect(screen.getByRole('button', { name: 'Read aloud' })).toBe(offered)
  })

  it('is withdrawn when the session that loads does not offer speech', () => {
    publish({ session: undefined })
    const { container } = render(button())
    expect(screen.getByRole('button', { name: 'Read aloud' })).toBeVisible()

    act(() =>
      publish({
        session: {
          ...testSession,
          features: { ...testSession.features, speech: false },
        },
      }),
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('is withdrawn when the session fails to load', () => {
    publish({ session: undefined })
    const { container } = render(button())
    expect(screen.getByRole('button', { name: 'Read aloud' })).toBeVisible()

    act(() => publish({ error: 'Tinfoil Chat could not start.' }))

    expect(container).toBeEmptyDOMElement()
  })

  it('is not offered outside a chat the harness can read', () => {
    const { container } = render(
      <ReadAloudButton messageId="reply-1" content="Hello." />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('reads plain text without a message through a keyless speech request', async () => {
    signIn()
    client.stream.mockImplementation(
      (_path: string, _input: unknown, signal: AbortSignal) =>
        speech.speak('text', signal),
    )
    render(<ReadAloudButton content="Selected words." />)

    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))

    await waitFor(() => expect(speech.responses).toHaveLength(1))
    expect(client.stream).toHaveBeenCalledExactlyOnceWith(
      '/v1/speech',
      { text: 'Selected words.' },
      expect.any(AbortSignal),
    )
    await act(async () => {
      speech.responses[0].push(2)
      speech.responses[0].finish()
    })
    await screen.findByRole('button', { name: 'Stop reading aloud' })
  })

  it('starts on click, exposes buffering and stop controls, and returns to idle', async () => {
    render(button())
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    expect(
      screen.getByRole('button', { name: 'Cancel read aloud' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Buffering audio — click to cancel'),
    ).toBeInTheDocument()
    await waitFor(() => expect(speech.responses).toHaveLength(1))
    expect(speech.responses[0].messageId).toBe('reply-1')
    await act(async () => {
      speech.responses[0].push(2)
      speech.responses[0].finish()
    })
    const stopButton = await screen.findByRole('button', {
      name: 'Stop reading aloud',
    })
    expect(audio.scheduled.length).toBeGreaterThan(0)
    fireEvent.click(stopButton)
    expect(
      screen.getByRole('button', { name: 'Read aloud' }),
    ).toBeInTheDocument()
    expect(audio.close).toHaveBeenCalledOnce()
  })

  it('aborts the request when the message changes', async () => {
    const view = render(button('Original.'))
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    await waitFor(() => expect(speech.responses).toHaveLength(1))
    view.rerender(button('Edited.'))
    expect(speech.responses[0].signal.aborted).toBe(true)
    expect(
      screen.getByRole('button', { name: 'Read aloud' }),
    ).toBeInTheDocument()
  })

  it.each(['resume', 'stop'])(
    'can %s paused speech without requesting it again',
    async (action) => {
      render(button())
      fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
      await waitFor(() => expect(speech.responses).toHaveLength(1))
      await act(async () => {
        speech.responses[0].push(2)
        speech.responses[0].finish()
      })
      await screen.findByRole('button', { name: 'Stop reading aloud' })
      const scheduled = audio.scheduled.length
      act(() => {
        audio.state = 'suspended'
        audio.onstatechange?.()
      })
      expect(screen.getByRole('status')).toHaveTextContent('Speech paused')
      expect(screen.getByText('Resume reading aloud')).toBeInTheDocument()
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
        expect(audio.scheduled).toHaveLength(scheduled)
      } else {
        fireEvent.click(
          screen.getByRole('button', { name: 'Stop reading aloud' }),
        )
        expect(
          screen.getByRole('button', { name: 'Read aloud' }),
        ).toBeInTheDocument()
        expect(audio.close).toHaveBeenCalledOnce()
      }
      expect(speech.responses).toHaveLength(1)
    },
  )

  it('aborts the request on unmount', async () => {
    const view = render(button())
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    await waitFor(() => expect(speech.responses).toHaveLength(1))
    view.unmount()
    expect(speech.responses[0].signal.aborted).toBe(true)
  })

  it('shows a safe error and allows another attempt', async () => {
    render(button())
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    await waitFor(() => expect(speech.responses).toHaveLength(1))
    await act(async () => {
      speech.responses[0].fail(new Error('private response text'))
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not read this response aloud.',
    )
    expect(screen.getByRole('alert')).not.toHaveTextContent('private')
    fakes.context.mockReturnValue(new FakeAudioContext())
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    await waitFor(() => expect(speech.responses).toHaveLength(2))
  })
})
