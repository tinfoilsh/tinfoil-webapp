// @vitest-environment node
import { parseTar, primeTexmfCache } from '@/services/latex/texmf-pack'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

function makeTar(entries: Record<string, string>): Buffer {
  // The build script writes its own ustar; the parser must also read what a
  // stock tar produces, so build the fixture with the system tar.
  const dir = mkdtempSync(join(tmpdir(), 'texmf-'))
  for (const [name, content] of Object.entries(entries)) {
    execFileSync('mkdir', ['-p', join(dir, name, '..')])
    writeFileSync(join(dir, name), content)
  }
  return execFileSync('tar', [
    'cf',
    '-',
    '--format=ustar',
    '-C',
    dir,
    ...Object.keys(entries),
  ])
}

afterEach(() => vi.unstubAllGlobals())

describe('texmf pack', () => {
  it('parses ustar entries including a prefix-split path', () => {
    const long = 'tex/latex/' + 'a'.repeat(120) + '/file.sty'
    const files = parseTar(makeTar({ 'fmt/latex.fmt': 'FMT', [long]: 'x' }))
    expect([...files.keys()].sort()).toEqual(['fmt/latex.fmt', long].sort())
    expect(new TextDecoder().decode(files.get('fmt/latex.fmt'))).toBe('FMT')
  })

  it('stores every packed file in the worker cache keyed by bundle URL', async () => {
    const index = gzipSync(JSON.stringify({ version: 'v1', files: {} }))
    // Stock tar pads to 10 KiB records, so build this one entry by entry.
    const pack = gzipSync(
      Buffer.concat([
        tarEntry('fmt/latex.fmt', Buffer.from('FMT')),
        tarEntry('index.json.gz', index),
        Buffer.alloc(1024),
      ]),
    )
    const stored = new Map<string, Response>()
    const store = {
      match: async (key: string) => stored.get(key) ?? null,
      put: async (key: string, response: Response) =>
        void stored.set(key, response),
    }
    vi.stubGlobal('caches', {
      keys: async () => [],
      open: async (name: string) => {
        expect(name).toBe('tstex-v1')
        return store
      },
    })
    vi.stubGlobal('location', { href: 'https://chat.example/' })
    vi.stubGlobal('fetch', async (url: string) => {
      expect(url).toBe('https://chat.example/vendor/texmf/pack.tar.gz')
      return new Response(pack)
    })
    await primeTexmfCache('/vendor/texmf/')
    expect([...stored.keys()].sort()).toEqual([
      'https://chat.example/vendor/texmf/fmt/latex.fmt',
      'https://chat.example/vendor/texmf/index.json.gz',
    ])
    expect(
      await stored
        .get('https://chat.example/vendor/texmf/fmt/latex.fmt')!
        .text(),
    ).toBe('FMT')
  })
})

function tarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0)
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
  header.write('00000000000\0', 136)
  header.write('        ', 148)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148)
  return Buffer.concat([
    header,
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
  ])
}
