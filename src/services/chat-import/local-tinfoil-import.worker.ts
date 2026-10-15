import {
  collectTransferableBuffers,
  parseTinfoilExportBytes,
} from './local-tinfoil-import-parser'

interface ImportWorkerRequest {
  buffer: ArrayBuffer
  fileName: string
  mimeType: string
  maxArchiveBytes: number
}

interface ImportWorkerScope {
  onmessage: ((event: MessageEvent<ImportWorkerRequest>) => void) | null
  postMessage(message: unknown, transfer: Transferable[]): void
}

const workerScope = globalThis as unknown as ImportWorkerScope

workerScope.onmessage = (event) => {
  try {
    const { buffer, fileName, mimeType, maxArchiveBytes } = event.data
    const { conversations, entries } = parseTinfoilExportBytes({
      bytes: new Uint8Array(buffer),
      fileName,
      mimeType,
      maxArchiveBytes,
    })
    const transfer = collectTransferableBuffers(entries ?? {})
    workerScope.postMessage({ ok: true, conversations, entries }, transfer)
  } catch (error) {
    workerScope.postMessage(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to read export',
      },
      [],
    )
  }
}
