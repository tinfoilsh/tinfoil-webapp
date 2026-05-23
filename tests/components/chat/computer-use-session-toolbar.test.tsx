/**
 * Tests for the macOS-style traffic-light toolbar shared by the live session
 * thread and the static history card. Covers:
 *   - red light wired to onClose
 *   - yellow light wired to onMinimize
 *   - green light always non-interactive (reserved for a future maximize)
 *   - disabled prop (history card): all three lights non-interactive
 *   - status label + pulse render
 */
import {
  ComputerUseSessionCard,
  SessionToolbar,
} from '@/components/chat/ComputerUseSessionMessage'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

describe('SessionToolbar', () => {
  it('shows the status label and a pulse dot when pulse=true', () => {
    render(<SessionToolbar status="Working…" pulse />)
    expect(screen.getByText(/Working/)).toBeTruthy()
    // The pulse element doesn't have a role, but it has `animate-pulse` class.
    // Check it's in the DOM by looking for the bg-green-500 dot.
    expect(document.querySelector('.animate-pulse')).toBeTruthy()
  })

  it('omits the pulse dot when pulse is not set', () => {
    render(<SessionToolbar status="Done" />)
    expect(document.querySelector('.animate-pulse')).toBeNull()
  })

  it('red light fires onClose when interactive', () => {
    const onClose = vi.fn()
    render(<SessionToolbar status="Working…" onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('yellow light fires onMinimize when interactive', () => {
    const onMinimize = vi.fn()
    render(<SessionToolbar status="Working…" onMinimize={onMinimize} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Minimize session card' }),
    )
    expect(onMinimize).toHaveBeenCalledOnce()
  })

  it('green light is always disabled (reserved)', () => {
    const onMinimize = vi.fn()
    render(<SessionToolbar status="Working…" onMinimize={onMinimize} />)
    const green = screen.getByRole('button', {
      name: 'Maximize (reserved)',
    }) as HTMLButtonElement
    expect(green.disabled).toBe(true)
  })

  it('disabled toolbar (history card): all three lights are non-interactive', () => {
    const onClose = vi.fn()
    const onMinimize = vi.fn()
    render(
      <SessionToolbar
        status="Done"
        disabled
        onClose={onClose}
        onMinimize={onMinimize}
      />,
    )
    const red = screen.getByRole('button', {
      name: 'Stop session',
    }) as HTMLButtonElement
    const yellow = screen.getByRole('button', {
      name: 'Minimize session card',
    }) as HTMLButtonElement
    expect(red.disabled).toBe(true)
    expect(yellow.disabled).toBe(true)
    fireEvent.click(red)
    fireEvent.click(yellow)
    expect(onClose).not.toHaveBeenCalled()
    expect(onMinimize).not.toHaveBeenCalled()
  })

  it('red is disabled when no onClose is given (e.g. handoff phase)', () => {
    render(<SessionToolbar status="Paused" onMinimize={() => {}} />)
    const red = screen.getByRole('button', {
      name: 'Stop session',
    }) as HTMLButtonElement
    expect(red.disabled).toBe(true)
  })
})

describe('ComputerUseSessionCard (history) toolbar lights', () => {
  it('without onRemove: red is decorative (no funnel context)', () => {
    render(<ComputerUseSessionCard frames={[]} />)
    const red = screen.getByRole('button', {
      name: 'Stop session',
    }) as HTMLButtonElement
    // No onRemove → red has no onClick → falls back to disabled.
    expect(red.disabled).toBe(true)
  })

  it('with onRemove: red fires the remove handler (drop record from chat)', () => {
    const onRemove = vi.fn()
    render(<ComputerUseSessionCard frames={[]} onRemove={onRemove} />)
    const red = screen.getByRole('button', {
      name: 'Stop session',
    }) as HTMLButtonElement
    expect(red.disabled).toBe(false)
    fireEvent.click(red)
    expect(onRemove).toHaveBeenCalledOnce()
  })

  it('yellow always collapses the card body', () => {
    const { getByText, queryByText } = render(
      <ComputerUseSessionCard
        frames={[
          {
            type: 'model_message',
            content: 'driving Safari',
            reasoning: '',
            toolCalls: [],
          },
        ]}
      />,
    )
    // Frames initially visible.
    expect(getByText('driving Safari')).toBeDefined()
    fireEvent.click(
      screen.getByRole('button', { name: 'Minimize session card' }),
    )
    expect(queryByText('driving Safari')).toBeNull()
  })

  it('green is always non-interactive (reserved)', () => {
    render(<ComputerUseSessionCard frames={[]} onRemove={() => {}} />)
    const green = screen.getByRole('button', {
      name: 'Maximize (reserved)',
    }) as HTMLButtonElement
    expect(green.disabled).toBe(true)
  })
})
