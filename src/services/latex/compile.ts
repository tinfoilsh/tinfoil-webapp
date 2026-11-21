/**
 * Client-side LaTeX compilation with tstex (pdfLaTeX in TypeScript).
 *
 * The engine runs in a Web Worker on this origin: `copy-vendor.mjs` copies
 * its dist to `public/vendor/tstex/` and the module is imported by URL at
 * runtime so the bundler leaves it, and the worker it spawns, alone. TeX Live
 * files come from `LATEX_TEXMF_URL`: the one-shot pack fills the worker's
 * Cache Storage first, anything else is fetched on demand and cached too.
 */
import { LATEX_TEXMF_URL } from '@/config'
import type { CompileResult, TeX } from '@lsd-cat/tstex'
import { primeTexmfCache } from './texmf-pack'

const TSTEX_URL = '/vendor/tstex/index.js'
export const LATEX_COMPILE_TIMEOUT_MS = 120_000

let engine: Promise<TeX> | null = null

function getEngine(): Promise<TeX> {
  engine ??= primeTexmfCache(LATEX_TEXMF_URL)
    .catch(() => undefined)
    .then(
      () =>
        import(
          /* webpackIgnore: true */ /* turbopackIgnore: true */ TSTEX_URL
        ) as Promise<typeof import('@lsd-cat/tstex')>,
    )
    .then((module) =>
      module.createTeX({ texmf: LATEX_TEXMF_URL, cache: 'persistent' }),
    )
  return engine
}

export type LatexFiles = Record<string, string | Uint8Array>

/**
 * Compile `main.tex` from `files`. Resolves with the engine's result even
 * when TeX reported errors (`ok: false`, `pdf: null`, see `log`); rejects on
 * abort, timeout or an engine failure.
 */
export async function compileLatex(
  files: LatexFiles,
  signal?: AbortSignal,
): Promise<CompileResult> {
  const signals = [AbortSignal.timeout(LATEX_COMPILE_TIMEOUT_MS)]
  if (signal) signals.push(signal)
  const tex = await getEngine()
  try {
    return await tex.compile({
      files,
      main: 'main.tex',
      runs: 'auto',
      signal: AbortSignal.any(signals),
    })
  } catch (error) {
    // A dead worker poisons every later request; start fresh next time.
    if (!signal?.aborted) {
      engine = null
      tex.dispose()
    }
    throw error
  }
}

/**
 * The lines of a pdfTeX log that explain a failure: each `!` error with the
 * two lines after it (usually the input line and context), capped so the
 * summary fits in a repair prompt.
 */
export function summarizeLatexLog(log: string, maxChars = 1500): string {
  const lines = log.split('\n')
  const picked: string[] = []
  for (let i = 0; i < lines.length && picked.length < 30; i++) {
    if (lines[i].startsWith('!')) picked.push(...lines.slice(i, i + 3))
  }
  const summary = (picked.length ? picked : lines.slice(-8)).join('\n')
  return summary.length > maxChars ? summary.slice(0, maxChars) : summary
}
