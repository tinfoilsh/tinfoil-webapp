import { imageSize } from '@/services/computer-use/image-size'
import { describe, expect, it } from 'vitest'
import { TINY_PNG } from './fixtures'

function toBase64(bytes: number[]): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** Craft a minimal PNG whose IHDR carries the given dimensions. */
function pngOf(width: number, height: number): string {
  const u32 = (n: number) => [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ]
  return toBase64([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a, // signature
    0x00,
    0x00,
    0x00,
    0x0d, // IHDR length
    0x49,
    0x48,
    0x44,
    0x52, // "IHDR"
    ...u32(width),
    ...u32(height),
    0x08,
    0x06,
    0x00,
    0x00,
    0x00, // bit depth, color type, etc.
  ])
}

/** Craft a minimal JPEG with a single SOF0 segment carrying the dimensions. */
function jpegOf(width: number, height: number): string {
  const hi = (n: number) => (n >> 8) & 0xff
  const lo = (n: number) => n & 0xff
  return toBase64([
    0xff,
    0xd8, // SOI
    0xff,
    0xc0, // SOF0
    0x00,
    0x11, // segment length
    0x08, // precision
    hi(height),
    lo(height),
    hi(width),
    lo(width),
    0x03, // components (truncated; parser only needs the dimensions)
  ])
}

describe('imageSize', () => {
  it('reads PNG dimensions', () => {
    expect(imageSize(pngOf(1024, 665))).toEqual({ width: 1024, height: 665 })
  })

  it('reads the 1x1 fixture PNG', () => {
    expect(imageSize(TINY_PNG)).toEqual({ width: 1, height: 1 })
  })

  it('reads JPEG dimensions from the SOF segment', () => {
    expect(imageSize(jpegOf(1280, 800))).toEqual({ width: 1280, height: 800 })
  })

  it('returns null for non-image data', () => {
    expect(imageSize(btoa('not an image at all'))).toBeNull()
  })

  it('returns null for invalid base64', () => {
    expect(imageSize('@@@not base64@@@')).toBeNull()
  })
})
