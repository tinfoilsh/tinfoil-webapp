import type { NATIVE_BACKUP_IMAGE_MIME_TYPES } from './schemas'

export type NativeBackupImageMimeType =
  (typeof NATIVE_BACKUP_IMAGE_MIME_TYPES)[number]

export function detectNativeBackupImageMimeType(
  bytes: Uint8Array,
): NativeBackupImageMimeType | null {
  const has = (...values: number[]) =>
    values.every((value, index) => bytes[index] === value)
  if (bytes.length >= 8 && has(137, 80, 78, 71, 13, 10, 26, 10))
    return 'image/png'
  if (bytes.length >= 3 && has(255, 216, 255)) return 'image/jpeg'
  const text = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end))
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(text(0, 6)))
    return 'image/gif'
  if (bytes.length >= 12 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP')
    return 'image/webp'
  if (bytes.length >= 2 && has(66, 77)) return 'image/bmp'
  return null
}
