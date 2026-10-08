import { RedactedText } from '@/components/ui/redacted-text'
import { render, screen } from '@testing-library/react'
import { Window } from 'happy-dom'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { beforeAll, describe, expect, it } from 'vitest'

let css: string
beforeAll(async () => {
  const stylesheetPath = resolve('src/styles/tailwind.css')
  css = (
    await postcss([tailwindcss(resolve('tailwind.config.js'))]).process(
      await readFile(stylesheetPath, 'utf8'),
      { from: stylesheetPath },
    )
  ).css
})

describe('RedactedText', () => {
  it.each([
    { device: 'mouse', maxTouchPoints: 0, opacity: '0', display: 'block' },
    { device: 'touch', maxTouchPoints: 1, opacity: '1', display: 'none' },
  ])(
    'applies active redaction for $device without exposing the block to accessibility',
    async ({ maxTouchPoints, opacity, display }) => {
      const view = render(
        <RedactedText active={true}>Private title</RedactedText>,
      )

      const source = screen.getByText('Private title')
      const container = source.parentElement
      const block = container?.querySelector('.redacted-text-block')

      expect(container).toHaveClass('redacted-text')
      expect(source).toHaveClass('redacted-text-source')
      expect(block).toHaveAttribute('aria-hidden', 'true')
      const browserWindow = new Window({
        settings: { navigator: { maxTouchPoints } },
      })
      try {
        const style = browserWindow.document.createElement('style')
        style.textContent = css
        browserWindow.document.head.append(style)
        browserWindow.document.body.innerHTML = view.container.innerHTML
        const renderedSource = browserWindow.document.querySelector(
          '.redacted-text-source',
        )!
        const renderedBlock = browserWindow.document.querySelector(
          '.redacted-text-block',
        )!
        expect(
          browserWindow.getComputedStyle(renderedSource).opacity || '1',
        ).toBe(opacity)
        expect(browserWindow.getComputedStyle(renderedBlock).display).toBe(
          display,
        )
      } finally {
        await browserWindow.happyDOM.close()
      }
    },
  )

  it('renders only the source text when inactive', () => {
    render(<RedactedText active={false}>Current chat</RedactedText>)

    const source = screen.getByText('Current chat')
    expect(source.parentElement).not.toHaveClass('redacted-text')
    expect(
      source.parentElement?.querySelector('.redacted-text-block'),
    ).toBeNull()
  })
})
