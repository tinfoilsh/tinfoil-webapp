/**
 * Read the pixel dimensions of a base64-encoded PNG or JPEG by parsing the
 * header bytes — no decoding, no DOM, synchronous (works in the loop and in
 * tests). The loop needs the screenshot's pixel size to interpret the
 * coordinates a model emits: Kimi K2.6 grounds in coordinates relative to the
 * exact frame it was shown (confirmed via live probe — it emits pixel coords
 * scaled to the screenshot, and reverts to normalized 0..1 in some conditions).
 */

export interface ImageSize {
  width: number
  height: number
}

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Parse width/height from PNG/JPEG header bytes; `null` if unrecognized. */
export function imageSize(base64: string): ImageSize | null {
  let b: Uint8Array
  try {
    b = base64ToBytes(base64)
  } catch {
    return null
  }
  return parsePng(b) ?? parseJpeg(b)
}

function parsePng(b: Uint8Array): ImageSize | null {
  if (b.length < 24) return null
  for (let i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) return null
  // IHDR is the first chunk: length(4) + "IHDR"(4) at offset 8, then width(4)
  // big-endian at offset 16, height(4) at offset 20.
  const width = readU32(b, 16)
  const height = readU32(b, 20)
  if (width === 0 || height === 0) return null
  return { width, height }
}

function parseJpeg(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let off = 2
  while (off + 9 < b.length) {
    if (b[off] !== 0xff) {
      off++
      continue
    }
    const marker = b[off + 1]
    // SOF markers carry the frame dimensions: C0..CF except C4/C8/CC.
    const isSOF =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    if (isSOF) {
      // segment: FF, marker, length(2), precision(1), height(2), width(2)
      const height = (b[off + 5] << 8) | b[off + 6]
      const width = (b[off + 7] << 8) | b[off + 8]
      if (width === 0 || height === 0) return null
      return { width, height }
    }
    // Standalone markers (no length) — skip past.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      off += 2
      continue
    }
    const len = (b[off + 2] << 8) | b[off + 3]
    if (len < 2) return null
    off += 2 + len
  }
  return null
}

function readU32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
}
