/**
 * In-origin preview runner documents.
 *
 * The preview payload is embedded as a JSON data block and processed by a
 * script served from this origin (`/preview/*-run.js`), so the nested
 * document runs under the app's own CSP: scripts from this origin only, no
 * inline code, no eval. Under WEBCAT the runner and its libraries are hashed
 * in the manifest and the payload never leaves the verified origin.
 *
 * The frame is `srcdoc` + `sandbox="allow-scripts"`, so its origin is opaque;
 * `'self'` would match nothing there, which is why the policy names the
 * origin explicitly.
 */
export type RunnerDocumentOptions = {
  /** Path of the runner script on this origin, e.g. `/preview/mermaid-run.js`. */
  script: string
  /** Payload for the runner; `origin` is added automatically. */
  data: Record<string, unknown>
  /** Allow WebAssembly compilation (Pyodide). */
  wasm?: boolean
  /** Allow inline styles (Mermaid output, CSS preview). */
  styles?: boolean
  /** Extra markup for <head> and <body>. */
  head?: string
  body?: string
}

export function buildRunnerDocument({
  script,
  data,
  wasm = false,
  styles = false,
  head = '',
  body = '',
}: RunnerDocumentOptions): string {
  const origin = window.location.origin
  const csp = [
    "default-src 'none'",
    `script-src ${origin}${wasm ? " 'wasm-unsafe-eval'" : ''}`,
    `connect-src ${origin}`,
    styles ? "style-src 'unsafe-inline'" : null,
    'img-src data:',
    'font-src data:',
  ]
    .filter(Boolean)
    .join('; ')
  // `<` is escaped so the payload can never terminate the data block.
  const json = JSON.stringify({ ...data, origin }).replace(/</g, '\\u003c')
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp};">` +
    head +
    '</head><body>' +
    body +
    `<script type="application/json" id="data">${json}</script>` +
    `<script type="module" src="${origin}${script}"></script>` +
    '</body></html>'
  )
}
