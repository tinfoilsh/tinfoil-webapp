/**
 * Tests for the macOS-style traffic-light toolbar shared by the live session
 * thread and the static history card.
 */
import { ComputerUseSessionCard } from '@/components/chat/ComputerUseSessionMessage'
import { ComputerUseSessionToolbar } from '@/components/chat/ComputerUseSessionToolbar'
import type { CapabilityManifest } from '@/services/computer-use'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const MANIFEST: CapabilityManifest = {
  version: 1,
  session: { os: 'mac', image: 'tinfoil-default', clone: true },
}

describe('ComputerUseSessionToolbar', () => {
  it('renders a pulsing dot when the VM is running', () => {
    render(
      <ComputerUseSessionToolbar vmStatus="running" errors={[]} frames={[]} />,
    )
    expect(document.querySelector('.animate-pulse')).toBeTruthy()
  })

  it('renders the image name in the title block', () => {
    render(
      <ComputerUseSessionToolbar
        vmStatus="running"
        imageName="tinfoil-default"
        errors={[]}
        frames={[]}
      />,
    )
    expect(screen.getByText('tinfoil-default')).toBeTruthy()
  })

  it('red light fires onClose when interactive', () => {
    const onClose = vi.fn()
    render(
      <ComputerUseSessionToolbar
        vmStatus="running"
        errors={[]}
        frames={[]}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('yellow light fires onMinimize when interactive', () => {
    const onMinimize = vi.fn()
    render(
      <ComputerUseSessionToolbar
        vmStatus="running"
        errors={[]}
        frames={[]}
        onMinimize={onMinimize}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Minimize session card' }),
    )
    expect(onMinimize).toHaveBeenCalledOnce()
  })

  it('green light fires onExpand and flips the aria-label when expanded', () => {
    const onExpand = vi.fn()
    const { rerender } = render(
      <ComputerUseSessionToolbar
        vmStatus="running"
        errors={[]}
        frames={[]}
        onExpand={onExpand}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Expand session card' }))
    expect(onExpand).toHaveBeenCalledOnce()
    rerender(
      <ComputerUseSessionToolbar
        vmStatus="running"
        errors={[]}
        frames={[]}
        onExpand={onExpand}
        expanded
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Contract session card' }),
    ).toBeTruthy()
  })

  it('green is disabled when no onExpand handler is provided', () => {
    render(
      <ComputerUseSessionToolbar vmStatus="stopped" errors={[]} frames={[]} />,
    )
    const green = screen.getByRole('button', {
      name: 'Expand session card',
    }) as HTMLButtonElement
    expect(green.disabled).toBe(true)
  })

  it('disabled toolbar: all three lights are non-interactive', () => {
    const onClose = vi.fn()
    const onMinimize = vi.fn()
    const onExpand = vi.fn()
    render(
      <ComputerUseSessionToolbar
        vmStatus="stopped"
        errors={[]}
        frames={[]}
        disabled
        onClose={onClose}
        onMinimize={onMinimize}
        onExpand={onExpand}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Minimize session card' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Expand session card' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(onMinimize).not.toHaveBeenCalled()
    expect(onExpand).not.toHaveBeenCalled()
  })

  it('renders the bug icon only when errors are present', () => {
    const { rerender } = render(
      <ComputerUseSessionToolbar vmStatus="running" errors={[]} frames={[]} />,
    )
    expect(screen.queryByLabelText(/error/i)).toBeNull()
    rerender(
      <ComputerUseSessionToolbar
        vmStatus="running"
        errors={[
          {
            id: 'fatal',
            source: 'fatal',
            message: 'JSON parse error at char 29',
          },
        ]}
        frames={[]}
      />,
    )
    expect(screen.getByLabelText(/1 error/)).toBeTruthy()
  })

  it('agent activity icon is always shown', () => {
    render(
      <ComputerUseSessionToolbar vmStatus="running" errors={[]} frames={[]} />,
    )
    expect(screen.getByLabelText('Agent activity')).toBeTruthy()
  })

  it('terminal toggle is hidden until a handler is provided', () => {
    const { rerender } = render(
      <ComputerUseSessionToolbar vmStatus="running" errors={[]} frames={[]} />,
    )
    expect(screen.queryByLabelText(/terminal/i)).toBeNull()
    rerender(
      <ComputerUseSessionToolbar
        vmStatus="running"
        errors={[]}
        frames={[]}
        onToggleTerminal={() => {}}
      />,
    )
    expect(screen.getByLabelText('Show terminal')).toBeTruthy()
  })

  it('VM control toggles between play and pause', () => {
    const onTogglePause = vi.fn()
    const { rerender } = render(
      <ComputerUseSessionToolbar
        vmStatus="running"
        errors={[]}
        frames={[]}
        onTogglePause={onTogglePause}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Pause VM' }))
    expect(onTogglePause).toHaveBeenCalledOnce()
    rerender(
      <ComputerUseSessionToolbar
        vmStatus="paused"
        errors={[]}
        frames={[]}
        onTogglePause={onTogglePause}
      />,
    )
    expect(screen.getByRole('button', { name: 'Resume VM' })).toBeTruthy()
  })

  // The idle timer used to live in the toolbar; it now floats over the
  // live VM view (ComputerUseLiveView). The toolbar no longer accepts an
  // `idleTimeout` prop, so there's nothing to assert here — the new
  // location is covered indirectly by the live-view component.

  it('config icon is shown when the manifest is known', () => {
    render(
      <ComputerUseSessionToolbar
        vmStatus="running"
        errors={[]}
        frames={[]}
        manifest={MANIFEST}
      />,
    )
    expect(screen.getByLabelText('Sandbox configuration')).toBeTruthy()
  })
})

describe('ComputerUseSessionCard (history) toolbar', () => {
  it('without onRemove: red light is decorative', () => {
    render(<ComputerUseSessionCard frames={[]} />)
    const red = screen.getByRole('button', {
      name: 'Stop session',
    }) as HTMLButtonElement
    expect(red.disabled).toBe(true)
  })

  it('with onRemove: red light drops the record', () => {
    const onRemove = vi.fn()
    render(<ComputerUseSessionCard frames={[]} onRemove={onRemove} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }))
    expect(onRemove).toHaveBeenCalledOnce()
  })
})
