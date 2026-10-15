import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import {
  collectTransferableBuffers,
  parseTinfoilExportBytes,
} from '@/services/chat-import/local-tinfoil-import-parser'

const parserOptions = {
  fileName: 'conversations.json',
  mimeType: 'application/json',
  maxArchiveBytes: 1024,
}

describe('parseTinfoilExportBytes', () => {
  it('deduplicates shared buffers before worker transfer', () => {
    const buffer = new ArrayBuffer(8)

    expect(
      collectTransferableBuffers({
        first: new Uint8Array(buffer, 0, 4),
        second: new Uint8Array(buffer, 4, 4),
      }),
    ).toEqual([buffer])
  })

  it('parses JSON conversation arrays', () => {
    const conversations = [{ name: 'Imported chat' }]

    expect(
      parseTinfoilExportBytes({
        ...parserOptions,
        bytes: new TextEncoder().encode(JSON.stringify(conversations)),
      }),
    ).toEqual({ conversations })
  })

  it('rejects JSON that is not a conversation array', () => {
    expect(() =>
      parseTinfoilExportBytes({
        ...parserOptions,
        bytes: new TextEncoder().encode('{}'),
      }),
    ).toThrow('Invalid Tinfoil export format')
  })

  it('rejects ZIP exports without conversations.json', () => {
    const bytes = zipSync({ 'manifest.json': strToU8('{}') })

    expect(() =>
      parseTinfoilExportBytes({
        ...parserOptions,
        bytes,
        fileName: 'export.zip',
        mimeType: 'application/zip',
      }),
    ).toThrow('The Tinfoil export is missing conversations.json')
  })

  it('enforces the uncompressed archive limit', () => {
    const bytes = zipSync({
      'conversations.json': strToU8(JSON.stringify([])),
      'attachments/large.txt': strToU8('too large'),
    })

    expect(() =>
      parseTinfoilExportBytes({
        ...parserOptions,
        bytes,
        fileName: 'export.zip',
        mimeType: 'application/zip',
        maxArchiveBytes: 4,
      }),
    ).toThrow('The uncompressed export is too large')
  })
})
