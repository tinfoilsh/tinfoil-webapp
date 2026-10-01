// Copy the pinned Pyodide and Mermaid distributions into public/vendor/ so the
// in-origin preview runners load them from this origin (hashed by the WEBCAT
// manifest) instead of a CDN. Runs before `next build` and `next dev`.
import fs from 'node:fs'
import path from 'node:path'

const out = (p) => path.join('public/vendor', p)
fs.rmSync('public/vendor', { recursive: true, force: true })

fs.mkdirSync(out('pyodide'), { recursive: true })
for (const f of [
  'pyodide.mjs',
  'pyodide.asm.js',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
]) {
  fs.copyFileSync(`node_modules/pyodide/${f}`, out(`pyodide/${f}`))
}

const chunks = 'chunks/mermaid.esm.min'
fs.mkdirSync(out(`mermaid/${chunks}`), { recursive: true })
fs.copyFileSync(
  'node_modules/mermaid/dist/mermaid.esm.min.mjs',
  out('mermaid/mermaid.esm.min.mjs'),
)
for (const f of fs
  .readdirSync(`node_modules/mermaid/dist/${chunks}`)
  .filter((f) => f.endsWith('.mjs'))) {
  fs.copyFileSync(
    `node_modules/mermaid/dist/${chunks}/${f}`,
    out(`mermaid/${chunks}/${f}`),
  )
}

const version = (pkg) =>
  JSON.parse(fs.readFileSync(`node_modules/${pkg}/package.json`, 'utf8'))
    .version
console.log(
  `public/vendor: pyodide ${version('pyodide')}, mermaid ${version('mermaid')}`,
)
