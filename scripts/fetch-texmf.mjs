// Mirror the tstex TeX Live bundle into public/vendor/texmf/ so the LaTeX
// worker fetches fonts and packages from this origin (connect-src 'self'),
// and write pack.tar.gz: the files the shipped templates need, in one
// download, which the app unpacks into the worker's Cache Storage. Downloads
// are kept in node_modules/.cache/texmf/ so repeated builds do not refetch.
// Runs after copy-vendor.mjs (which empties public/vendor/).
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

const SOURCE =
  process.env.TEXMF_SOURCE_URL ||
  'https://lsd-cat.github.io/tstex/bundles/minimal/'
const cacheDir = 'node_modules/.cache/texmf'
const outDir = 'public/vendor/texmf'
const packList = fs
  .readFileSync('scripts/texmf-pack-files.txt', 'utf8')
  .split('\n')
  .filter(Boolean)

async function fetchFile(file) {
  const target = path.join(cacheDir, file)
  if (fs.existsSync(target)) return
  const res = await fetch(SOURCE + file)
  if (!res.ok) throw new Error(`${SOURCE}${file}: HTTP ${res.status}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()))
}

async function fetchAll(files, concurrency = 16) {
  const queue = [...files]
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) await fetchFile(f)
    }),
  )
}

// Minimal ustar writer: every bundle path is far below the 100-byte name
// field, so no prefix or long-name entries are needed.
function tarEntry(name, data) {
  if (Buffer.byteLength(name) > 100)
    throw new Error(`tar name too long: ${name}`)
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
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512)
  return Buffer.concat([header, data, padding])
}

await fetchFile('index.json.gz')
const index = JSON.parse(
  gunzipSync(fs.readFileSync(path.join(cacheDir, 'index.json.gz'))).toString(),
)
const files = [
  'fmt/latex.fmt',
  ...Object.values(index.files).map((f) => f.path),
]
await fetchAll(files)

fs.rmSync(outDir, { recursive: true, force: true })
fs.cpSync(cacheDir, outDir, { recursive: true })

const missing = packList.filter((f) => !fs.existsSync(path.join(cacheDir, f)))
if (missing.length)
  throw new Error(`pack list not in bundle: ${missing.join(', ')}`)
const entries = ['index.json.gz', 'fmt/latex.fmt', ...packList].map((f) =>
  tarEntry(f, fs.readFileSync(path.join(cacheDir, f))),
)
const tar = Buffer.concat([...entries, Buffer.alloc(1024)])
fs.writeFileSync(path.join(outDir, 'pack.tar.gz'), gzipSync(tar, { level: 9 }))
console.log(
  `public/vendor/texmf: ${files.length} files from ${SOURCE} (version ${index.version}), pack.tar.gz ${entries.length} entries`,
)
