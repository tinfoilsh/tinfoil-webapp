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
  it('shows the "Done" header + final summary when frames are present', () => {
    const { getByText } = render(
      ComputerUseSessionRenderer.render({
        message: msg({
          content: 'all set',
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
    expect(getByText(/Done/)).toBeDefined()
    expect(getByText('all set')).toBeDefined()
    expect(getByText('opening Safari')).toBeDefined()
  })

  it('shows the "Error" header + error banner when computerUseError is set', () => {
    const { getByText } = render(
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
    expect(getByText(/Error/)).toBeDefined()
    expect(getByText('VM did not boot')).toBeDefined()
  })
})
