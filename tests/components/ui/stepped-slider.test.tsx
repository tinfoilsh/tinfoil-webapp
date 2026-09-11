import { SteppedSlider } from '@/components/ui/stepped-slider'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const STEPS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
] as const

function ControlledSlider() {
  const [value, setValue] = useState<(typeof STEPS)[number]['id']>('medium')
  return (
    <SteppedSlider
      steps={STEPS}
      value={value}
      onValueChange={setValue}
      aria-label="Intelligence"
    />
  )
}

afterEach(cleanup)

describe('SteppedSlider', () => {
  it.each(STEPS)('exposes the selected $label step and bounds', (step) => {
    render(
      <SteppedSlider
        steps={STEPS}
        value={step.id}
        onValueChange={vi.fn()}
        aria-label="Intelligence"
      />,
    )

    const thumb = screen.getByRole('slider', { name: 'Intelligence' })
    expect(thumb).toHaveAttribute('aria-valuenow', String(STEPS.indexOf(step)))
    expect(thumb).toHaveAttribute('aria-valuetext', step.label)
    expect(thumb).toHaveAttribute('aria-valuemin', '0')
    expect(thumb).toHaveAttribute('aria-valuemax', String(STEPS.length - 1))
  })

  it('moves between steps with arrow keys and stays within the endpoints', () => {
    render(<ControlledSlider />)
    const thumb = screen.getByRole('slider', { name: 'Intelligence' })

    for (const [key, label] of [
      ['ArrowRight', 'High'],
      ['ArrowRight', 'High'],
      ['ArrowLeft', 'Medium'],
      ['ArrowDown', 'Low'],
      ['ArrowDown', 'Low'],
      ['ArrowUp', 'Medium'],
    ]) {
      fireEvent.keyDown(thumb, { key })
      expect(thumb).toHaveAttribute('aria-valuetext', label)
      expect(thumb).toHaveAttribute(
        'aria-valuenow',
        String(STEPS.findIndex((step) => step.label === label)),
      )
    }
  })

  it('jumps to the first and last steps with Home and End', () => {
    render(<ControlledSlider />)
    const thumb = screen.getByRole('slider', { name: 'Intelligence' })

    fireEvent.keyDown(thumb, { key: 'Home' })
    expect(thumb).toHaveAttribute('aria-valuetext', 'Low')

    fireEvent.keyDown(thumb, { key: 'End' })
    expect(thumb).toHaveAttribute('aria-valuetext', 'High')
  })

  it('follows external value changes without emitting a selection', () => {
    const onValueChange = vi.fn()
    const props = {
      steps: STEPS,
      onValueChange,
      'aria-label': 'Intelligence',
    }
    const { rerender } = render(<SteppedSlider {...props} value="low" />)

    rerender(<SteppedSlider {...props} value="high" />)

    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', 'High')
    expect(onValueChange).not.toHaveBeenCalled()
  })
})
