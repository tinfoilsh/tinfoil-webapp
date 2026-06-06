import { ComputerUseSessionRenderer } from '@/components/chat/renderers/ComputerUseSessionRenderer'
import type { Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

// Minimal model stub — only the fields the renderer touches.
const model = { modelName: 'kimi-k2-6' } as unknown as BaseModel

function msg(over: Partial<Message>): Message {
  return {
    role: 'assistant',
    content: '',
    timestamp: new Date('2026-05-22T00:00:00Z'),
    ...over,
  }
}

describe('ComputerUseSessionRenderer.canRender', () => {
  it('claims messages with a frames array', () => {
    expect(
      ComputerUseSessionRenderer.canRender(
        msg({ computerUseFrames: [] }),
        model,
      ),
    ).toBe(true)
  })

  it('claims messages with an error string', () => {
    expect(
      ComputerUseSessionRenderer.canRender(
        msg({ computerUseError: 'VM did not boot' }),
        model,
      ),
    ).toBe(true)
  })

  it('does NOT claim a regular assistant message', () => {
    expect(
      ComputerUseSessionRenderer.canRender(msg({ content: 'hi there' }), model),
    ).toBe(false)
  })
})

describe('ComputerUseSessionRenderer.render', () => {
  it('renders the static card with a stopped VM dot for a finished session', () => {
    const { container, queryByText } = render(
      ComputerUseSessionRenderer.render({
        message: msg({
          content: '',
          computerUseFrames: [
            {
              type: 'model_message',
              content: 'opening Safari',
              reasoning: '',
              toolCalls: [],
            },
          ],
        }),
        messageIndex: 0,
        model,
        isDarkMode: false,
      }),
    )
    // The card no longer renders the frame trail inline — the agent
    // activity popover owns that. We just assert the shell rendered.
    expect(
      container.querySelector('button[aria-label="Stop session"]'),
    ).toBeTruthy()
    // The standalone assistant message holds the final answer.
    expect(queryByText('all set')).toBeNull()
  })

  it('surfaces the fatal error message in the bug popover when set', () => {
    const { getByLabelText } = render(
      ComputerUseSessionRenderer.render({
        message: msg({
          isError: true,
          computerUseError: 'VM did not boot',
          computerUseFrames: [],
        }),
        messageIndex: 0,
        model,
        isDarkMode: false,
      }),
    )
    // The bug icon's aria-label includes the error count, so its presence
    // is enough — clicking the popover open isn't part of this surface
    // test.
    expect(getByLabelText(/1 error/)).toBeTruthy()
  })

  it('preserves the final screenshot and surfaces the stop reason', () => {
    const { getByAltText, queryByText } = render(
      ComputerUseSessionRenderer.render({
        message: msg({
          computerUseFrames: [
            {
              type: 'begin',
              session: 'sess_1',
              screenshot: {
                content: [
                  { type: 'image', data: 'AAAA', mimeType: 'image/png' },
                ],
              },
            },
            { type: 'stopped', reason: 'model_finished', finalText: '' },
          ],
        }),
        messageIndex: 0,
        model,
        isDarkMode: false,
      }),
    )
    const img = getByAltText('Final sandbox screenshot') as HTMLImageElement
    expect(img.src).toContain('data:image/png;base64,AAAA')
    expect(queryByText(/the agent finished/)).toBeTruthy()
  })

  it('shows the final screenshot even when the session errored', () => {
    const { getByAltText, queryByText } = render(
      ComputerUseSessionRenderer.render({
        message: msg({
          isError: true,
          computerUseError: 'inference 400',
          computerUseFrames: [
            {
              type: 'begin',
              session: 'sess_2',
              screenshot: {
                content: [
                  { type: 'image', data: 'BBBB', mimeType: 'image/png' },
                ],
              },
            },
          ],
        }),
        messageIndex: 0,
        model,
        isDarkMode: false,
      }),
    )
    expect(getByAltText('Final sandbox screenshot')).toBeTruthy()
    expect(queryByText(/Session ended with an error/)).toBeTruthy()
  })
})
