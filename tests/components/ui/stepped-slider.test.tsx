import { SteppedSlider } from '@/components/ui/stepped-slider'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Window } from 'happy-dom'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import postcss from 'postcss'
import { useState } from 'react'
import tailwindcss from 'tailwindcss'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

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

  describe('computed fill animation', () => {
    let css: string

    beforeAll(async () => {
      const stylesheetPath = resolve('src/styles/tailwind.css')
      const configPath = resolve('tailwind.config.js')
      const result = await postcss([tailwindcss(configPath)]).process(
        await readFile(stylesheetPath, 'utf8'),
        { from: stylesheetPath },
      )
      css = result.css
    })

    it.each(['no-preference', 'reduce'])(
      'animates the max fill only when motion is allowed (%s)',
      async (motion) => {
        const browserWindow = new Window({
          settings: { device: { prefersReducedMotion: motion } },
        })
        try {
          const style = browserWindow.document.createElement('style')
          style.textContent = css
          browserWindow.document.head.append(style)
          const { container } = render(<ControlledSlider />)
          const thumb = screen.getByRole('slider', { name: 'Intelligence' })
          expect(container.querySelector('.stepped-slider-max-fill')).toBeNull()

          for (const key of ['End', 'ArrowLeft']) {
            fireEvent.keyDown(thumb, { key })
            if (key === 'End') {
              expect(
                container.querySelector('.stepped-slider-max-fill'),
              ).toBeInTheDocument()
            } else {
              expect(thumb).toHaveAttribute('aria-valuetext', 'Medium')
              expect(
                container.querySelector('.stepped-slider-max-fill'),
              ).toBeNull()
            }
            browserWindow.document.body.innerHTML = container.innerHTML
            const fill = browserWindow.document.querySelector(
              '.bg-tinfoil-accent-blue',
            )!
            const computed = browserWindow.getComputedStyle(fill)

            expect(computed.animation).toBe(
              key === 'End' && motion === 'no-preference'
                ? 'slider-max-flow 8s linear infinite'
                : '',
            )
          }
        } finally {
          await browserWindow.happyDOM.close()
        }
      },
    )
  })
})
