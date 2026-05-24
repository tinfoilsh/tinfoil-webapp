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

describe('ComputerUseToolButton (unpaired state)', () => {
  it('desktop: click calls onConnect instead of onToggle when paired=false', () => {
    const onToggle = vi.fn()
    const onConnect = vi.fn()
    render(
      <ComputerUseToolButton
        {...base}
        paired={false}
        onConnect={onConnect}
        onToggle={onToggle}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /Pair computer driver/i }),
    )
    expect(onConnect).toHaveBeenCalledOnce()
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('desktop: shows the "Click to pair" tooltip when paired=false', () => {
    render(
      <ComputerUseToolButton
        {...base}
        paired={false}
        onConnect={() => {}}
        onToggle={() => {}}
      />,
    )
    expect(screen.getByText('Click to pair to computer driver')).toBeTruthy()
  })

  it('desktop: paired=true keeps the original toggle behavior', () => {
    const onToggle = vi.fn()
    const onConnect = vi.fn()
    render(
      <ComputerUseToolButton
        {...base}
        paired={true}
        onConnect={onConnect}
        onToggle={onToggle}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Computer use' }))
    expect(onToggle).toHaveBeenCalledOnce()
    expect(onConnect).not.toHaveBeenCalled()
  })

  it('mobile: click calls onConnect when paired=false', () => {
    const onToggle = vi.fn()
    const onConnect = vi.fn()
    render(
      <ComputerUseToolButton
        {...base}
        variant="mobile"
        paired={false}
        onConnect={onConnect}
        onToggle={onToggle}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /Pair computer driver/i }),
    )
    expect(onConnect).toHaveBeenCalledOnce()
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('not supported: clicking does nothing even when unpaired', () => {
    const onToggle = vi.fn()
    const onConnect = vi.fn()
    render(
      <ComputerUseToolButton
        {...base}
        supported={false}
        reason="needs vision"
        paired={false}
        onConnect={onConnect}
        onToggle={onToggle}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Computer use' }))
    expect(onConnect).not.toHaveBeenCalled()
    expect(onToggle).not.toHaveBeenCalled()
  })
})

describe('ComputerUseToolButton (ask mode — first-touch, driver absent)', () => {
  it('desktop: when supported=false + onAsk is wired, click calls onAsk (not disabled)', () => {
    const onAsk = vi.fn()
    const onConnect = vi.fn()
    const onToggle = vi.fn()
    render(
      <ComputerUseToolButton
        {...base}
        supported={false}
        reason="Computer driver not detected — click to ask Tin about computer use."
        paired={false}
        onConnect={onConnect}
        onToggle={onToggle}
        onAsk={onAsk}
      />,
    )
    const btn = screen.getByRole('button', {
      name: 'Ask about computer use',
    }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(btn.className).toMatch(/cursor-help/)
    fireEvent.click(btn)
    expect(onAsk).toHaveBeenCalledOnce()
    expect(onConnect).not.toHaveBeenCalled()
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('desktop: shows the parent-provided reason as the tooltip', () => {
    render(
      <ComputerUseToolButton
        {...base}
        supported={false}
        reason="Computer driver not detected — click to ask Tin about computer use."
        paired={false}
        onAsk={() => {}}
        onToggle={() => {}}
      />,
    )
    expect(
      screen.getByText(/click to ask Tin about computer use/i),
    ).toBeTruthy()
  })

  it('mobile: ask-mode click calls onAsk, button is enabled + cursor-help', () => {
    const onAsk = vi.fn()
    render(
      <ComputerUseToolButton
        {...base}
        variant="mobile"
        supported={false}
        reason="Computer driver not detected"
        paired={false}
        onAsk={onAsk}
        onToggle={() => {}}
      />,
    )
    const btn = screen.getByRole('button', {
      name: /Ask about computer use/i,
    }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(btn.className).toMatch(/cursor-help/)
    fireEvent.click(btn)
    expect(onAsk).toHaveBeenCalledOnce()
  })

  it('without onAsk, supported=false still disables the button (no funnel)', () => {
    render(
      <ComputerUseToolButton
        {...base}
        supported={false}
        reason="needs vision"
        paired={false}
        onToggle={() => {}}
      />,
    )
    const btn = screen.getByRole('button', {
      name: 'Computer use',
    }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})
