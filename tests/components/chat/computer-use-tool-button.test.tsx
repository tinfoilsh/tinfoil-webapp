import { ComputerUseToolButton } from '@/components/chat/ComputerUseToolButton'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const base = {
  enabled: false,
  isDarkMode: false,
  supported: true,
}

describe('ComputerUseToolButton (desktop)', () => {
  it('renders the toggle', () => {
    render(<ComputerUseToolButton {...base} onToggle={() => {}} />)
    expect(screen.getByRole('button', { name: 'Computer use' })).toBeTruthy()
  })

  it('toggles on click when supported', () => {
    const onToggle = vi.fn()
    render(<ComputerUseToolButton {...base} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button', { name: 'Computer use' }))
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('shows the "Computer" label only when enabled', () => {
    const { rerender } = render(
      <ComputerUseToolButton {...base} enabled={false} onToggle={() => {}} />,
    )
    expect(screen.queryByText('Computer')).toBeNull()
    rerender(<ComputerUseToolButton {...base} enabled onToggle={() => {}} />)
    expect(screen.getByText('Computer')).toBeTruthy()
  })

  it('is disabled for a non-vision model, does not toggle, and explains why', () => {
    const onToggle = vi.fn()
    render(
      <ComputerUseToolButton
        {...base}
        supported={false}
        reason="Computer use needs a vision-capable model — this model cannot see screenshots."
        onToggle={onToggle}
      />,
    )
    const btn = screen.getByRole('button', {
      name: 'Computer use',
    }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onToggle).not.toHaveBeenCalled()
    expect(screen.getByText(/vision-capable/i)).toBeTruthy()
  })
})

describe('ComputerUseToolButton (mobile)', () => {
  it('renders a menu row that toggles when supported', () => {
    const onToggle = vi.fn()
    render(
      <ComputerUseToolButton {...base} variant="mobile" onToggle={onToggle} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /computer use/i }))
    expect(onToggle).toHaveBeenCalledOnce()
  })
})
