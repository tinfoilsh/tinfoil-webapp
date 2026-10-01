// clerk-js builds its timer worker from a blob URL, which worker-src 'self'
// forbids. On every install this rewrites the pinned bundle to load the
// worker from /workers/clerk-timers.js and extracts that worker's source
// into public/ verbatim. Idempotent, version-independent, and fails loudly
// if Clerk restructures the code so a bump cannot silently regress.
import fs from 'node:fs'

const BUNDLE = 'node_modules/@clerk/clerk-js/dist/clerk.no-rhc.mjs'
const OUT = 'public/workers/clerk-timers.js'
const MARKER = 'new Worker("/workers/clerk-timers.js"'

let src = fs.readFileSync(BUNDLE, 'utf8')

// The worker source is the only string literal mentioning workerToTabIds.
const worker = src.match(/'((?:[^'\\]|\\.)*workerToTabIds(?:[^'\\]|\\.)*)'/)
if (!worker) throw new Error(`${BUNDLE}: timer worker source not found`)
const workerSource = JSON.parse(
  `"${worker[1].replace(/\\'/g, "'").replace(/"/g, '\\"')}"`,
)
fs.mkdirSync('public/workers', { recursive: true })
fs.writeFileSync(
  OUT,
  "// Clerk's timer worker, extracted verbatim from @clerk/clerk-js by\n" +
    '// scripts/patch-clerk-worker.mjs. Served from this origin so it runs under\n' +
    "// worker-src 'self' and is hashed like any other asset.\n" +
    workerSource +
    '\n',
)

if (!src.includes(MARKER)) {
  // let t=new Blob([e],{type:"application/javascript; charset=utf-8"}),r=globalThis.URL.createObjectURL(t);return new Worker(r,a)
  const creation =
    /let (\w+)=new Blob\(\[(\w+)\],\{type:"application\/javascript; charset=utf-8"\}\),(\w+)=globalThis\.URL\.createObjectURL\(\1\);return new Worker\(\3,(\w+)\)/g
  const matches = [...src.matchAll(creation)]
  if (matches.length !== 1)
    throw new Error(
      `${BUNDLE}: expected one blob worker creation, found ${matches.length}`,
    )
  src = src.replace(creation, (_, _t, _e, _r, opts) => `${MARKER},${opts})`)
  fs.writeFileSync(BUNDLE, src)
}
console.log(
  `clerk timer worker -> ${OUT}; bundle loads it from /workers/clerk-timers.js`,
)
