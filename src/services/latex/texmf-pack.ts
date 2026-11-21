/**
 * One-shot priming of the LaTeX worker's file cache.
 *
 * tstex fetches bundle files one by one with synchronous requests, but with
 * `cache: 'persistent'` it first loads everything found in Cache Storage
 * under `tstex-<bundle version>`. `scripts/fetch-texmf.mjs` packs the files
 * the shipped templates need into `pack.tar.gz`; this module downloads that
 * once, unpacks it and stores each file where the worker will look for it.
 */

/** Parse a ustar archive into path -> bytes (regular files only). */
export function parseTar(tar: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  const ascii = (start: number, length: number) => {
    const end = tar.indexOf(0, start)
    return new TextDecoder().decode(
      tar.subarray(
        start,
        end < 0 || end > start + length ? start + length : end,
      ),
    )
  }
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = ascii(offset, 100)
    if (!name) break
    const size = parseInt(ascii(offset + 124, 12), 8)
    const type = tar[offset + 156]
    const prefix = ascii(offset + 345, 155)
    const data = tar.subarray(offset + 512, offset + 512 + size)
    if (type === 0x30 || type === 0) {
      files.set(prefix ? `${prefix}/${name}` : name, data)
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Fill the worker's cache from `<texmf>/pack.tar.gz` unless a bundle is
 * already stored. Failures are swallowed: without the pack the worker still
 * works, fetching files one at a time.
 */
export async function primeTexmfCache(texmfUrl: string): Promise<void> {
  if (typeof caches === 'undefined') return
  const base = new URL(texmfUrl, location.href).href
  for (const name of await caches.keys()) {
    if (!name.startsWith('tstex-')) continue
    const store = await caches.open(name)
    if (await store.match(base + 'fmt/latex.fmt')) return
  }
  const response = await fetch(base + 'pack.tar.gz')
  if (!response.ok || !response.body) return
  const tar = new Uint8Array(
    await new Response(
      response.body.pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer(),
  )
  const files = parseTar(tar)
  const index = files.get('index.json.gz')
  if (!index) return
  const { version } = JSON.parse(new TextDecoder().decode(await gunzip(index)))
  const store = await caches.open(`tstex-${version}`)
  await Promise.all(
    [...files].map(([path, bytes]) =>
      store.put(base + path, new Response(bytes as BlobPart)),
    ),
  )
}
