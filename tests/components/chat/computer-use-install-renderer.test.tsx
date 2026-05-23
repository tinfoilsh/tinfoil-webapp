/**
 * Tests for the static install-funnel renderer that took over from the
 * GenUI widget. The card now lives on `Message.computerUseInstallSuggestion`
 * — the webapp commits the message; the model is not involved.
 */
import { ComputerUseInstallRenderer } from '@/components/chat/renderers/ComputerUseInstallRenderer'
import type { Message } from '@/components/chat/types'
import type { BaseModel } from '@/config/models'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

const model = { modelName: 'kimi-k2-6' } as unknown as BaseModel

function msg(over: Partial<Message>): Message {
  return {
    role: 'assistant',
    content: '',
    timestamp: new Date('2026-05-22T00:00:00Z'),
    ...over,
  }
}

describe('ComputerUseInstallRenderer.canRender', () => {
  it('claims messages carrying the install-suggestion marker', () => {
    expect(
      ComputerUseInstallRenderer.canRender(
        msg({ computerUseInstallSuggestion: {} }),
        model,
      ),
    ).toBe(true)
  })

  it('does not claim a regular assistant message', () => {
    expect(
      ComputerUseInstallRenderer.canRender(msg({ content: 'hi' }), model),
    ).toBe(false)
  })

  it('does not claim a computer-use session record (different renderer)', () => {
    expect(
      ComputerUseInstallRenderer.canRender(
        msg({ computerUseFrames: [] }),
        model,
      ),
    ).toBe(false)
  })
})

describe('ComputerUseInstallRenderer.render', () => {
  it('renders the install card with the canonical command + a "watching" status row', () => {
    const { getByText } = render(
      ComputerUseInstallRenderer.render({
        message: msg({ computerUseInstallSuggestion: {} }),
        messageIndex: 0,
        model,
        isDarkMode: false,
      }),
    )
    expect(getByText('Install Tinfoil computer use')).toBeDefined()
    expect(getByText(/curl -fsSL/)).toBeDefined()
    // The in-card connection-status row should be present and (in the test
    // env with no broker reachable) show the watching state.
    expect(getByText(/Watching for the local driver/i)).toBeDefined()
  })

  it('renders an optional reason when provided', () => {
    const { getByText } = render(
      ComputerUseInstallRenderer.render({
        message: msg({
          computerUseInstallSuggestion: {
            reason: 'You asked how to enable computer use.',
          },
        }),
        messageIndex: 0,
        model,
        isDarkMode: false,
      }),
    )
    expect(getByText(/You asked how to enable computer use/)).toBeDefined()
  })
})
