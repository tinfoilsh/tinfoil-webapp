import { parseTinfoilExportBytes } from '@/services/chat-import/local-tinfoil-import-parser'

interface WorkerRequest {
  buffer: ArrayBuffer
  fileName: string
  mimeType: string
  maxArchiveBytes: number
}

type ImportParser = typeof parseTinfoilExportBytes

export function createFunctionalImportWorker(
  parseExport: ImportParser = parseTinfoilExportBytes,
): typeof Worker {
  return class FunctionalImportWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    onmessageerror: (() => void) | null = null

    postMessage(message: unknown) {
      const request = message as WorkerRequest
      queueMicrotask(() => {
        try {
          const result = parseExport({
            bytes: new Uint8Array(request.buffer),
            fileName: request.fileName,
            mimeType: request.mimeType,
            maxArchiveBytes: request.maxArchiveBytes,
          })
          this.onmessage?.({ data: { ok: true, ...result } } as MessageEvent)
        } catch (error) {
          this.onmessage?.({
            data: {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to read export',
            },
          } as MessageEvent)
        }
      })
    }

    terminate() {}
  } as unknown as typeof Worker
}
