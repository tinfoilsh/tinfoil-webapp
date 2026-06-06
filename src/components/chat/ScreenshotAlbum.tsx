/**
 * Fullscreen screenshot viewer with album navigation.
 *
 * Fit mode (default): the image is scaled DOWN to fit within the viewport on
 * both axes, aspect ratio always preserved — never upscaled, never stretched.
 * This is the fix for the old viewer, which let frames overflow / stretch.
 *
 * Zoom mode: the image is widened past fit (a multiple of the viewer width)
 * and the backdrop scrolls both axes. Screenshots are landscape, so "fit" is
 * effectively width-limited and the numeric zoom reads as zooming in past it.
 *
 * Keyboard: Esc closes, ←/→ paginate, Home/End jump to ends, +/-/0 zoom.
 *
 * Used by the agent activity surfaces (history popover, timeline) — anything
 * with a list of screenshot data URLs to flip through.
 */

'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'

export interface AlbumImage {
  src: string
  caption?: string
}

// Zoom multipliers (of the viewer width) applied once the user zooms past fit.
const ZOOM_LEVELS: number[] = [1, 1.5, 2, 3, 4]

export function ScreenshotAlbum({
  album,
  index,
  onIndexChange,
  onClose,
}: {
  album: AlbumImage[]
  index: number
  onIndexChange: (i: number) => void
  onClose: () => void
}) {
  const current = album[index]
  const last = album.length - 1
  // null = fit-to-viewport; a number = that multiple of the viewer width.
  const [zoom, setZoom] = useState<number | null>(null)

  // Snap back to fit whenever the viewed image changes — carrying a zoom level
  // across frames of different sizes is disorienting.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setZoom(null)
  }, [index])

  const goPrev = useCallback(
    () => onIndexChange(index === 0 ? last : index - 1),
    [index, last, onIndexChange],
  )
  const goNext = useCallback(
    () => onIndexChange(index === last ? 0 : index + 1),
    [index, last, onIndexChange],
  )
  const zoomIn = useCallback(
    () =>
      setZoom((z) => {
        if (z == null) return ZOOM_LEVELS[0]
        const i = ZOOM_LEVELS.indexOf(z)
        return ZOOM_LEVELS[Math.min(i + 1, ZOOM_LEVELS.length - 1)]
      }),
    [],
  )
  const zoomOut = useCallback(
    () =>
      setZoom((z) => {
        if (z == null) return null
        const i = ZOOM_LEVELS.indexOf(z)
        return i <= 0 ? null : ZOOM_LEVELS[i - 1]
      }),
    [],
  )
  const toggleZoom = useCallback(
    () => setZoom((z) => (z == null ? ZOOM_LEVELS[0] : null)),
    [],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose()
          break
        case 'ArrowLeft':
          goPrev()
          break
        case 'ArrowRight':
          goNext()
          break
        case 'Home':
          onIndexChange(0)
          break
        case 'End':
          onIndexChange(last)
          break
        case '+':
        case '=':
          zoomIn()
          break
        case '-':
          zoomOut()
          break
        case '0':
          setZoom(null)
          break
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, goPrev, goNext, onIndexChange, last, zoomIn, zoomOut])

  if (!current) return null

  const isFit = zoom == null
  const atMaxZoom = zoom === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
  const zoomLabel = isFit ? 'Fit' : `${Math.round((zoom ?? 1) * 100)}%`

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Screenshot"
      className="fixed inset-0 z-[100] overflow-auto bg-black/80"
      onClick={onClose}
    >
      {/* Two layouts: flex-centred when it fits (clean vertical centring), a
          plain block when zoomed (mx-auto centres while small, then scrolls
          cleanly once the image is wider than the viewport — flex centring
          would clip the left edge instead of scrolling to it). */}
      {isFit ? (
        <div className="flex min-h-full items-center justify-center p-6">
          <img
            src={current.src}
            alt={current.caption ?? 'Screenshot'}
            onClick={(e) => {
              e.stopPropagation()
              toggleZoom()
            }}
            className="max-h-[calc(100vh-7rem)] max-w-full cursor-zoom-in rounded-lg border border-white/20 shadow-2xl"
          />
        </div>
      ) : (
        <div className="min-h-full p-6">
          <img
            src={current.src}
            alt={current.caption ?? 'Screenshot'}
            onClick={(e) => {
              e.stopPropagation()
              toggleZoom()
            }}
            style={{ width: `${(zoom ?? 1) * 100}%`, maxWidth: 'none' }}
            className="mx-auto block h-auto cursor-zoom-out rounded-lg border border-white/20 shadow-2xl"
          />
        </div>
      )}

      {/* Floating controls: album nav + zoom + counter. The wrapper ignores
          pointer events so clicks beside the chip fall through to the backdrop
          (dismiss); the chip itself re-enables them. */}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 flex justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-black/70 px-2 py-1 text-white shadow-lg backdrop-blur">
          {album.length > 1 && (
            <>
              <ChipButton onClick={goPrev} label="Previous screenshot">
                ←
              </ChipButton>
              <span className="px-1 font-mono text-[11px] tabular-nums text-white/80">
                {index + 1} / {album.length}
              </span>
              <ChipButton onClick={goNext} label="Next screenshot">
                →
              </ChipButton>
              <span className="mx-1 h-4 w-px bg-white/20" aria-hidden />
            </>
          )}
          <ChipButton onClick={zoomOut} label="Zoom out" disabled={isFit}>
            −
          </ChipButton>
          <button
            type="button"
            onClick={toggleZoom}
            aria-label="Toggle zoom"
            className="min-w-[3rem] rounded-md px-2 py-0.5 text-center font-mono text-[11px] text-white/80 hover:bg-white/15"
          >
            {zoomLabel}
          </button>
          <ChipButton onClick={zoomIn} label="Zoom in" disabled={atMaxZoom}>
            +
          </ChipButton>
        </div>
      </div>

      {current.caption && (
        <p
          className="pointer-events-none fixed inset-x-0 bottom-16 mx-auto max-w-prose px-4 text-center text-xs text-white/70"
          onClick={(e) => e.stopPropagation()}
        >
          {current.caption}
        </p>
      )}

      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="fixed right-4 top-4 rounded-md bg-black/60 px-2 py-1 text-xs text-white hover:bg-black/80"
      >
        Close · Esc
      </button>
    </div>
  )
}

function ChipButton({
  onClick,
  label,
  disabled,
  children,
}: {
  onClick: () => void
  label: string
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="rounded-md px-2 py-0.5 text-sm hover:bg-white/15 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}
