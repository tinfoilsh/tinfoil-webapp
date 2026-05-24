/**
 * Browser canvas-based screenshot reduction for the model turn.
 *
 * The driver returns a full PNG; the chat / persisted history / audit trail show
 * that full frame, but the copy sent to the model is re-encoded as JPEG (≈10×
 * smaller) — saving inference tokens and context, and shrinking the request body
 * (which also relieves main-thread pressure during a turn).
 *
 * Default is **quality-only** (no `maxDim`): re-encode at the SAME resolution, so
 * the model sees the same pixel grid and coordinates map 1:1 — no coordinate
 * handling changes. Setting `maxDim` also downscales; the loop derives the
 * coordinate frame from the reduced image, so clicks still map correctly.
 */

import { SETTINGS_COMPUTER_USE_IMAGE_QUALITY } from '@/constants/storage-keys'
import type { ImageReducer } from './loop-controller'

/** Default JPEG quality for the model-facing screenshot. */
export const DEFAULT_IMAGE_QUALITY = 0.6

/**
 * The user-tunable quality knob, read from localStorage (clamped 0.1–1). A
 * settings-modal control can write this key; absent ⇒ {@link DEFAULT_IMAGE_QUALITY}.
 */
export function getComputerUseImageQuality(): number {
  try {
    const raw = window.localStorage.getItem(SETTINGS_COMPUTER_USE_IMAGE_QUALITY)
    const q = raw === null ? NaN : Number.parseFloat(raw)
    if (Number.isFinite(q)) return Math.min(1, Math.max(0.1, q))
  } catch {
    // ignore (SSR / sandboxed storage)
  }
  return DEFAULT_IMAGE_QUALITY
}

export interface ReduceOpts {
  /** JPEG quality, 0–1. ~0.5–0.7 keeps text legible while cutting most bytes. */
  quality: number
  /** Optional max width/height in px; omit to keep the original resolution. */
  maxDim?: number
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('failed to decode screenshot'))
    img.src = src
  })
}

/**
 * Build an {@link ImageReducer} bound to the given options. Browser-only (uses
 * `Image` + `<canvas>`); if anything fails it falls back to the original image
 * so a reduction hiccup never breaks the loop.
 */
export function createCanvasImageReducer(opts: ReduceOpts): ImageReducer {
  return async (base64, mimeType) => {
    try {
      const img = await loadImage(`data:${mimeType};base64,${base64}`)
      const scale = opts.maxDim
        ? Math.min(1, opts.maxDim / Math.max(img.width, img.height))
        : 1
      const width = Math.max(1, Math.round(img.width * scale))
      const height = Math.max(1, Math.round(img.height * scale))

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      ctx.drawImage(img, 0, 0, width, height)

      const url = canvas.toDataURL('image/jpeg', opts.quality)
      const comma = url.indexOf(',')
      const reduced = comma >= 0 ? url.slice(comma + 1) : ''
      if (!reduced) throw new Error('empty encode')
      return { base64: reduced, mimeType: 'image/jpeg', width, height }
    } catch {
      // Fall back to the original — never let reduction break the run.
      return { base64, mimeType, width: 0, height: 0 }
    }
  }
}
