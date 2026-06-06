/**
 * Tests for ScreenshotAlbum — the fit-to-viewport screenshot viewer.
 *   - fits to viewport by default (no width override → aspect preserved)
 *   - clicking the image toggles into zoom mode (width override + scroll)
 *   - album navigation + counter + keyboard
 */
import { ScreenshotAlbum } from '@/components/chat/ScreenshotAlbum'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const ALBUM = [
  { src: 'data:image/png;base64,AAA', caption: 'first' },
  { src: 'data:image/png;base64,BBB', caption: 'second' },
  { src: 'data:image/png;base64,CCC' },
]

function setup(over: Partial<Parameters<typeof ScreenshotAlbum>[0]> = {}) {
  const onIndexChange = vi.fn()
  const onClose = vi.fn()
  render(
    <ScreenshotAlbum
      album={ALBUM}
      index={0}
      onIndexChange={onIndexChange}
      onClose={onClose}
      {...over}
    />,
  )
  return { onIndexChange, onClose }
}

describe('ScreenshotAlbum', () => {
  it('fits the image to the viewport by default (no forced width)', () => {
    setup()
    const img = screen.getByAltText('first') as HTMLImageElement
    // Fit mode: the browser sizes the image within max-w/max-h, so we never
    // pin an explicit width (that would be zoom mode).
    expect(img.style.width).toBe('')
    expect(img.className).toContain('max-h-')
    expect(screen.getByText('Fit')).toBeTruthy()
  })

  it('clicking the image zooms past fit (forces width + scroll)', () => {
    setup()
    const img = screen.getByAltText('first') as HTMLImageElement
    fireEvent.click(img)
    const zoomed = screen.getByAltText('first') as HTMLImageElement
    expect(zoomed.style.width).toBe('100%')
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('zoom-in steps up past 100% and zoom-out returns to fit', () => {
    setup()
    fireEvent.click(screen.getByLabelText('Zoom in'))
    expect(screen.getByText('100%')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Zoom in'))
    expect(screen.getByText('150%')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Zoom out'))
    fireEvent.click(screen.getByLabelText('Zoom out'))
    expect(screen.getByText('Fit')).toBeTruthy()
  })

  it('shows the album counter and paginates', () => {
    const { onIndexChange } = setup()
    expect(screen.getByText('1 / 3')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Next screenshot'))
    expect(onIndexChange).toHaveBeenCalledWith(1)
  })

  it('handles keyboard: arrows paginate, Esc closes', () => {
    const { onIndexChange, onClose } = setup()
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(onIndexChange).toHaveBeenCalledWith(1)
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(onIndexChange).toHaveBeenCalledWith(2) // wraps from 0 to last
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
