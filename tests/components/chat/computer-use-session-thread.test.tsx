/**
 * Tests for the live ComputerUseSessionThread component:
 *   - red light triggers cancel() (stop + teardown)
 *   - yellow light toggles the card body collapse
 *   - thread returns null on terminal phases (done/error)
 */
import { ComputerUseSessionThread } from '@/components/chat/ComputerUseSessionThread'
import type {
  ComputerUseSessionState,
  useComputerUseSession,
} from '@/services/computer-use'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type SessionApi = ReturnType<typeof useComputerUseSession>

function makeSession(
  state: Partial<ComputerUseSessionState> & {
    phase: ComputerUseSessionState['phase']
  },
): SessionApi {
  return {
    state: {
      task: '',
      images: [],
      frames: [],
      ...state,
    } as ComputerUseSessionState,
    start: vi.fn(),
    approve: vi.fn(),
    approveCapability: vi.fn(),
    denyCapability: vi.fn(),
    cancel: vi.fn(),
  }
}

describe('ComputerUseSessionThread', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  it('returns null on terminal phases (committed to history elsewhere)', () => {
    const { container } = render(
      <ComputerUseSessionThread session={makeSession({ phase: 'done' })} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the toolbar with Working… status during running phase', () => {
    render(
      <ComputerUseSessionThread session={makeSession({ phase: 'running' })} />,
    )
    expect(screen.getByText(/Working/)).toBeTruthy()
    // The pulse dot is rendered only during running.
    expect(document.querySelector('.animate-pulse')).toBeTruthy()
  })

  it('red light calls cancel on the session', () => {
    const session = makeSession({ phase: 'running' })
    render(<ComputerUseSessionThread session={session} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }))
    expect(session.cancel).toHaveBeenCalledOnce()
  })

  it('yellow light toggles the card body collapse', () => {
    const session = makeSession({
      phase: 'running',
      frames: [
        {
          type: 'model_message',
          content: 'opening Safari',
          reasoning: '',
          toolCalls: [],
        },
      ],
    })
    render(<ComputerUseSessionThread session={session} />)
    // Skip the 900ms booting-skeleton minimum-display window so frames render.
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    // The frame content should be visible initially.
    expect(screen.queryByText('opening Safari')).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: 'Minimize session card' }),
    )
    // After collapse, frames are gone, toolbar remains.
    expect(screen.queryByText('opening Safari')).toBeNull()
    expect(screen.getByText(/Working/)).toBeTruthy()
    // Click again to expand.
    fireEvent.click(
      screen.getByRole('button', { name: 'Minimize session card' }),
    )
    expect(screen.queryByText('opening Safari')).toBeTruthy()
  })

  it('handoff phase: red light is disabled (no teardown — user is driving)', () => {
    render(
      <ComputerUseSessionThread session={makeSession({ phase: 'handoff' })} />,
    )
    const red = screen.getByRole('button', {
      name: 'Stop session',
    }) as HTMLButtonElement
    expect(red.disabled).toBe(true)
  })
})
