import {
  prepareNativeBackupArchiveDestination,
  writeNativeBackupArchive,
  type NativeBackupArchiveInput,
  type NativeBackupWriterDependencies,
} from '@/services/native-backup'
import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js'

const manifestBytes = new TextEncoder().encode(
  '{"format":"tinfoil-native-backup","created_at":"2026-08-20T12:00:00.000Z"}',
)

function input(paths = ['z.json', 'a.json']): NativeBackupArchiveInput {
  return {
    manifestBytes,
    files: paths.map((path) => ({
      path,
      kind: 'projects',
      bytes: new Uint8Array([1, 2]),
    })),
  }
}

function mockDependencies(
  options: {
    file?: boolean
    compressedBytes?: number
    uncompressedBytes?: number
    afterAdd?: (path: string) => void | Promise<void>
    duringClose?: () => void
    onOutputClose?: () => void
  } = {},
) {
  const events = {
    paths: [] as string[],
    payloads: [] as Uint8Array[],
    outputAborts: 0,
    outputCloses: 0,
    blobReads: 0,
    blobOutputs: 0,
    fileOutputs: 0,
    zipCloses: 0,
    zipDateComponents: [] as number[][],
    zipEpochs: [] as number[],
  }
  const output = () =>
    new WritableStream<Uint8Array>({
      close: () => {
        events.outputCloses++
        options.onOutputClose?.()
      },
      abort: () => {
        events.outputAborts++
      },
    })
  const compressedBytes = options.compressedBytes ?? 1024
  const uncompressedBytes = options.uncompressedBytes ?? 1024
  const dependencies: NativeBackupWriterDependencies = {
    fileSystemAccessSupported: () => options.file ?? false,
    createFileWritable: async () => {
      events.fileOutputs++
      return output()
    },
    createBlobOutput: () => {
      events.blobOutputs++
      return {
        writable: output(),
        getData: async () => {
          events.blobReads++
          return new Blob(['complete'])
        },
      }
    },
    createZipWriter: (writable, zipOptions) => {
      events.zipDateComponents.push([
        zipOptions.lastModDate.getFullYear(),
        zipOptions.lastModDate.getMonth(),
        zipOptions.lastModDate.getDate(),
        zipOptions.lastModDate.getHours(),
      ])
      events.zipEpochs.push(zipOptions.lastModDate.getTime())
      const writer = writable.getWriter()
      return {
        add: async (path, bytes) => {
          events.paths.push(path)
          events.payloads.push(new Uint8Array(bytes))
          await options.afterAdd?.(path)
          await writer.write(new Uint8Array([1]))
        },
        close: async () => {
          events.zipCloses++
          await writer.write(new Uint8Array([1]))
          options.duringClose?.()
          await writer.close()
        },
      }
    },
    limits: {
      file: { compressedBytes, uncompressedBytes },
      blob: { compressedBytes, uncompressedBytes },
    },
  }
  return { dependencies, events }
}

describe('native backup archive writer', () => {
  it('uses a stable filename before archive collection', async () => {
    const original = Object.getOwnPropertyDescriptor(
      globalThis,
      'showSaveFilePicker',
    )
    const picker = vi.fn(async () => ({}) as FileSystemFileHandle)
    Object.defineProperty(globalThis, 'showSaveFilePicker', {
      configurable: true,
      value: picker,
    })
    try {
      await prepareNativeBackupArchiveDestination()
      expect(picker).toHaveBeenCalledWith(
        expect.objectContaining({ suggestedName: 'tinfoil-backup.zip' }),
      )
    } finally {
      if (original)
        Object.defineProperty(globalThis, 'showSaveFilePicker', original)
      else Reflect.deleteProperty(globalThis, 'showSaveFilePicker')
    }
  })

  it('writes the manifest and files one at a time in deterministic path order', async () => {
    const releases: Array<() => void> = []
    const gates = Array.from(
      { length: 3 },
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve)
        }),
    )
    let active = 0
    let peak = 0
    let added = 0
    const { dependencies, events } = mockDependencies({
      afterAdd: async () => {
        active++
        peak = Math.max(peak, active)
        await gates[added++]
        active--
      },
    })
    const archive = input()
    archive.files[0].bytes = new Uint8Array([9, 8])
    const writing = writeNativeBackupArchive(archive, {}, dependencies)
    try {
      for (const index of [0, 1, 2]) {
        await vi.waitFor(() => expect(events.paths).toHaveLength(index + 1))
        expect(events.outputCloses).toBe(0)
        releases[index]()
      }
    } finally {
      releases.forEach((release) => release())
    }

    const result = await writing

    expect(peak).toBe(1)
    expect(events.paths).toEqual(['manifest.json', 'a.json', 'z.json'])
    expect(events.payloads).toEqual([
      manifestBytes,
      new Uint8Array([1, 2]),
      new Uint8Array([9, 8]),
    ])
    expect(events.zipCloses).toBe(1)
    expect(events.outputCloses).toBe(1)
    expect(result).toMatchObject({
      kind: 'blob',
      filename: 'tinfoil-backup-2026-08-20.zip',
    })
    vi.stubGlobal('showSaveFilePicker', undefined)
    try {
      const encoded = await writeNativeBackupArchive(archive)
      if (encoded.kind !== 'blob') throw new Error('Expected Blob archive')
      const reader = new ZipReader(new BlobReader(encoded.blob), {
        useWebWorkers: false,
      })
      try {
        const entries = await reader.getEntries()
        expect(entries.map(({ filename }) => filename)).toEqual(events.paths)
        const bytes = []
        for (const entry of entries) {
          if (entry.directory) throw new Error('Unexpected directory entry')
          const date = entry.lastModDate
          expect([
            date.getFullYear(),
            date.getMonth(),
            date.getDate(),
            date.getHours(),
          ]).toEqual([1980, 0, 1, 0])
          expect(entry.extraFieldExtendedTimestamp).toBeUndefined()
          bytes.push(await entry.getData(new Uint8ArrayWriter()))
        }
        expect(bytes).toEqual(events.payloads)
      } finally {
        await reader.close()
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reads the filename date from the complete manifest JSON', async () => {
    const archive = input([])
    archive.manifestBytes = new TextEncoder().encode(
      JSON.stringify(
        {
          padding: 'x'.repeat(1100),
          created_at: '2026-08-20T12:00:00.000Z',
        },
        null,
        2,
      ),
    )
    const { dependencies } = mockDependencies({
      uncompressedBytes: archive.manifestBytes.length,
    })

    await expect(
      writeNativeBackupArchive(archive, {}, dependencies),
    ).resolves.toMatchObject({ filename: 'tinfoil-backup-2026-08-20.zip' })
  })

  it('rejects normalized calendar dates before opening output', async () => {
    const archive = input([])
    archive.manifestBytes = new TextEncoder().encode(
      JSON.stringify({ created_at: '2026-02-31T12:00:00.000Z' }),
    )
    const { dependencies, events } = mockDependencies()

    await expect(
      writeNativeBackupArchive(archive, {}, dependencies),
    ).rejects.toMatchObject({
      code: 'invalid_manifest',
    })
    expect(events.blobOutputs).toBe(0)
  })

  it('uses the larger file-backed limits without creating a fallback Blob', async () => {
    const archive = input([])
    const { dependencies, events } = mockDependencies({
      file: true,
      uncompressedBytes: archive.manifestBytes.byteLength,
    })
    dependencies.limits.blob.uncompressedBytes =
      archive.manifestBytes.byteLength - 1

    await expect(
      writeNativeBackupArchive(archive, {}, dependencies),
    ).resolves.toEqual({
      kind: 'file',
      filename: 'tinfoil-backup-2026-08-20.zip',
    })
    expect(events.fileOutputs).toBe(1)
    expect(events.blobOutputs).toBe(0)
    dependencies.fileSystemAccessSupported = () => false
    await expect(
      writeNativeBackupArchive(archive, {}, dependencies),
    ).rejects.toMatchObject({ code: 'uncompressed_limit' })
    expect(events.blobOutputs).toBe(0)
  })

  it('rejects oversized fallback input before creating a Blob writer', async () => {
    const archive = input([])
    const { dependencies, events } = mockDependencies({
      uncompressedBytes: archive.manifestBytes.byteLength - 1,
    })

    await expect(
      writeNativeBackupArchive(archive, {}, dependencies),
    ).rejects.toMatchObject({
      code: 'uncompressed_limit',
    })
    expect(events.blobOutputs).toBe(0)
  })

  it('aborts output and returns no Blob when compressed output exceeds its limit', async () => {
    const { dependencies, events } = mockDependencies({ compressedBytes: 1 })

    await expect(
      writeNativeBackupArchive(input(['a.json']), {}, dependencies),
    ).rejects.toMatchObject({
      code: 'compressed_limit',
    })
    expect(events.outputAborts).toBe(1)
    expect(events.outputCloses).toBe(0)
    expect(events.blobReads).toBe(0)
  })

  it('cancels and cleans up without surfacing a partial result', async () => {
    const controller = new AbortController()
    const { dependencies, events } = mockDependencies({
      afterAdd: (path) => {
        if (path === 'manifest.json') controller.abort()
      },
    })

    await expect(
      writeNativeBackupArchive(
        input(['a.json']),
        {
          signal: controller.signal,
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(events.paths).toEqual(['manifest.json'])
    expect(events.outputAborts).toBe(1)
    expect(events.outputCloses).toBe(0)
    expect(events.blobReads).toBe(0)
  })

  it('aborts a file destination when canceled immediately before commit', async () => {
    const controller = new AbortController()
    const { dependencies, events } = mockDependencies({
      file: true,
      duringClose: () => controller.abort(),
    })

    await expect(
      writeNativeBackupArchive(
        input([]),
        { signal: controller.signal },
        dependencies,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(events.outputAborts).toBe(1)
    expect(events.outputCloses).toBe(0)
  })

  it('finishes a file commit successfully when canceled during destination close', async () => {
    const controller = new AbortController()
    const { dependencies, events } = mockDependencies({
      file: true,
      onOutputClose: () => controller.abort(),
    })

    await expect(
      writeNativeBackupArchive(
        input([]),
        { signal: controller.signal },
        dependencies,
      ),
    ).resolves.toEqual({
      kind: 'file',
      filename: 'tinfoil-backup-2026-08-20.zip',
    })
    expect(events.outputCloses).toBe(1)
    expect(events.outputAborts).toBe(0)
  })

  it('discards a Blob when canceled during destination close', async () => {
    const controller = new AbortController()
    const { dependencies, events } = mockDependencies({
      onOutputClose: () => controller.abort(),
    })

    await expect(
      writeNativeBackupArchive(
        input([]),
        { signal: controller.signal },
        dependencies,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(events.outputCloses).toBe(1)
    expect(events.blobReads).toBe(0)
  })

  it('uses the same local ZIP date components across timezones', async () => {
    const originalTimezone = process.env.TZ
    const components: number[][] = []
    const epochs: number[] = []
    try {
      for (const timezone of ['UTC', 'America/Los_Angeles']) {
        process.env.TZ = timezone
        const { dependencies, events } = mockDependencies()
        await writeNativeBackupArchive(input([]), {}, dependencies)
        components.push(events.zipDateComponents[0])
        epochs.push(events.zipEpochs[0])
      }
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ
      else process.env.TZ = originalTimezone
    }

    expect(components).toEqual([
      [1980, 0, 1, 0],
      [1980, 0, 1, 0],
    ])
    expect(epochs[0]).not.toBe(epochs[1])
  })

  it.each(['../escape.json', '/absolute.json', 'C:/drive.json', 'a\\b.json'])(
    'rejects unsafe archive path %s before opening output',
    async (path) => {
      const { dependencies, events } = mockDependencies()

      await expect(
        writeNativeBackupArchive(input([path]), {}, dependencies),
      ).rejects.toMatchObject({
        code: 'unsafe_path',
      })
      expect(events.blobOutputs).toBe(0)
    },
  )

  it.each([
    [' a.json', 'a.json'],
    ['a.json ', 'a.json'],
    ['projects/ a.json', 'projects/a.json'],
    ['projects/ /a.json', 'projects/a.json'],
  ])(
    'rejects whitespace-normalized path collision %s with %s',
    async (path, other) => {
      const { dependencies, events } = mockDependencies()

      await expect(
        writeNativeBackupArchive(input([other, path]), {}, dependencies),
      ).rejects.toMatchObject({
        code: 'unsafe_path',
      })
      expect(events.paths).toEqual([])
      expect(events.blobOutputs).toBe(0)
    },
  )
})
