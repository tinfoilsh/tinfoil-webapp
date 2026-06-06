/**
 * Tests for the live ComputerUseSessionThread component:
 *   - thread mounts whenever a sessionId exists, regardless of phase
 *   - red light triggers cancel() (stop + teardown)
 *   - yellow light toggles the card body collapse
 *   - thread returns null while there is no session
 */
import { ComputerUseSessionThread } from '@/components/chat/ComputerUseSessionThread'
import type {
  ComputerUseSessionState,
  useComputerUseSession,
} from '@/services/computer-use'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub the live view: it never connects on its own in jsdom (and would error
// on the missing getAccessToken), so we capture its props and drive the
// connection callback by hand to exercise the booting-skeleton gating.
const live = vi.hoisted(() => ({
  props: null as { onConnectionStateChange?: (s: string) => void } | null,
}))
vi.mock('@/components/chat/ComputerUseLiveView', () => ({
  ComputerUseLiveView: (props: {
    onConnectionStateChange?: (s: string) => void
  }) => {
    live.props = props
    return null
  },
}))

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
      // The thread mounts when a sessionId is set; tests that exercise
      // rendering rely on this default. Tests that need the "no live
      // session" branch override it to undefined.
      sessionId: 'sess_test',
      ...state,
    } as ComputerUseSessionState,
    start: vi.fn(),
    approve: vi.fn(),
    approveCapability: vi.fn(),
    denyCapability: vi.fn(),
    cancel: vi.fn(),
    connect: vi.fn(),
  }
}

describe('ComputerUseSessionThread', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null when there is no live session', () => {
    const { container } = render(
      <ComputerUseSessionThread
        session={makeSession({ phase: 'idle', sessionId: undefined })}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the toolbar with a pulsing VM indicator during running phase', () => {
    render(
      <ComputerUseSessionThread session={makeSession({ phase: 'running' })} />,
    )
    expect(document.querySelector('.animate-pulse')).toBeTruthy()
  })

  it('shows the booting skeleton in the boot window — running before sessionId', () => {
    // phase 'running' precedes the first `begin` event that sets sessionId.
    // The thread must still mount (and show the skeleton) during this gap —
    // the regression was that it returned null with no sessionId.
    render(
      <ComputerUseSessionThread
        session={makeSession({ phase: 'running', sessionId: undefined })}
      />,
    )
    expect(screen.queryByText(/Booting sandbox/)).toBeTruthy()
  })

  it('lifts the skeleton only once the live view reports connected', () => {
    render(
      <ComputerUseSessionThread session={makeSession({ phase: 'running' })} />,
    )
    // sessionId is set → live view mounted, skeleton overlaid while it
    // connects. The first frame landing does NOT lift it (gating is on the
    // connection, not the frame count).
    expect(screen.queryByText(/Booting sandbox/)).toBeTruthy()
    act(() => live.props?.onConnectionStateChange?.('connecting'))
    expect(screen.queryByText(/Booting sandbox/)).toBeTruthy()
    act(() => live.props?.onConnectionStateChange?.('connected'))
    expect(screen.queryByText(/Booting sandbox/)).toBeNull()
  })

  it('stays mounted after the agent finishes — operator keeps using the VM', () => {
    render(
      <ComputerUseSessionThread session={makeSession({ phase: 'done' })} />,
    )
    // Toolbar (and its red traffic light) renders even though the agent
    // is done; the live view stays available until the operator clicks
    // Stop, which fires cancel().
    expect(screen.getByRole('button', { name: 'Stop session' })).toBeTruthy()
  })

  it('red light calls cancel on the session', () => {
    const session = makeSession({ phase: 'running' })
    render(<ComputerUseSessionThread session={session} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }))
    expect(session.cancel).toHaveBeenCalledOnce()
  })

  it('yellow light toggles the card body collapse', () => {
    // Visibility is asserted via the booting skeleton's text — the skeleton
    // owns the body slot until a frame arrives, so its presence is a clean
    // proxy for "body is mounted".
    const session = makeSession({ phase: 'running' })
    render(<ComputerUseSessionThread session={session} />)
    expect(screen.queryByText(/Booting sandbox/)).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: 'Minimize session card' }),
    )
    expect(screen.queryByText(/Booting sandbox/)).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: 'Minimize session card' }),
    )
    expect(screen.queryByText(/Booting sandbox/)).toBeTruthy()
  })

  it('handoff phase: red light still ends the session (user override)', () => {
    const session = makeSession({ phase: 'handoff' })
    render(<ComputerUseSessionThread session={session} />)
    const red = screen.getByRole('button', {
      name: 'Stop session',
    }) as HTMLButtonElement
    expect(red.disabled).toBe(false)
    fireEvent.click(red)
    expect(session.cancel).toHaveBeenCalledOnce()
  })
})
