import { strFromU8, unzipSync } from 'fflate'

export const TINFOIL_CONVERSATIONS_FILE = 'conversations.json'
export const TINFOIL_MANIFEST_FILE = 'manifest.json'
export const TINFOIL_ATTACHMENTS_PREFIX = 'attachments/'

export interface ParsedTinfoilExport<T> {
  conversations: T[]
  entries?: Record<string, Uint8Array>
}

export function collectTransferableBuffers(
  entries: Record<string, Uint8Array>,
): ArrayBuffer[] {
  return Array.from(
    new Set(
      Object.values(entries)
        .map((entry) => entry.buffer)
        .filter((entry): entry is ArrayBuffer => entry instanceof ArrayBuffer),
    ),
  )
}

export function parseTinfoilExportBytes<T>(options: {
  bytes: Uint8Array
  fileName: string
  mimeType: string
  maxArchiveBytes: number
}): ParsedTinfoilExport<T> {
  const { bytes, fileName, mimeType, maxArchiveBytes } = options
  const isZip =
    fileName.toLowerCase().endsWith('.zip') || mimeType === 'application/zip'

  if (!isZip) {
    const conversations = JSON.parse(new TextDecoder().decode(bytes))
    if (!Array.isArray(conversations)) {
      throw new Error('Invalid Tinfoil export format')
    }
    return { conversations }
  }

  let uncompressedBytes = 0
  const entries = unzipSync(bytes, {
    filter: (entry) => {
      const isImportEntry =
        entry.name === TINFOIL_CONVERSATIONS_FILE ||
        entry.name === TINFOIL_MANIFEST_FILE ||
        entry.name.startsWith(TINFOIL_ATTACHMENTS_PREFIX)
      if (!isImportEntry) return false

      uncompressedBytes += entry.originalSize
      if (uncompressedBytes > maxArchiveBytes) {
        throw new Error('The uncompressed export is too large')
      }
      return true
    },
  })
  const conversationsEntry = entries[TINFOIL_CONVERSATIONS_FILE]
  if (!conversationsEntry) {
    throw new Error(
      `The Tinfoil export is missing ${TINFOIL_CONVERSATIONS_FILE}`,
    )
  }

  const conversations = JSON.parse(strFromU8(conversationsEntry))
  if (!Array.isArray(conversations)) {
    throw new Error('Invalid Tinfoil export format')
  }
  return { conversations, entries }
}
