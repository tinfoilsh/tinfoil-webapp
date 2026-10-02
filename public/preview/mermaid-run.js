// Runs in /preview/mermaid.html, a verified page on the app origin, framed
// with an opaque origin. Same protocol as the sandbox origin (see
// sandbox-frame.tsx): announce readiness with the nonce from the URL fragment
// until a run arrives, then render each run that follows in place.
const nonce = location.hash.slice(1)
let current = null
let seq = 0
let rendered = false
const post = (m) =>
  parent.postMessage({ ...m, instanceId: current.instanceId }, '*')

const announce = setInterval(
  () => parent.postMessage({ type: 'tinfoil-sandbox-ready', nonce }, '*'),
  250,
)
setTimeout(() => clearInterval(announce), 30_000)

const mermaidReady = import('/vendor/mermaid/mermaid.esm.min.mjs').then(
  (m) => m.default,
)

const report = () =>
  rendered &&
  post({
    type: 'mermaid-preview-height',
    height: Math.ceil(document.documentElement.scrollHeight),
  })
new ResizeObserver(report).observe(document.body)

window.addEventListener('message', async (event) => {
  const run = event.data
  if (event.source !== window.parent) return
  if (run?.type !== 'tinfoil-sandbox-run' || run.kind !== 'mermaid') return
  clearInterval(announce)
  current = run
  const mine = ++seq
  try {
    const mermaid = await mermaidReady
    mermaid.initialize({
      startOnLoad: false,
      theme: run.isDarkMode ? 'dark' : 'default',
      securityLevel: 'strict',
      // Labels as SVG text rather than <foreignObject>, as before.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      class: { htmlLabels: false },
    })
    const { svg } = await mermaid.render('diagram' + mine, String(run.code))
    if (mine !== seq) return
    // Replace only now, so a re-render never flashes an empty frame.
    document.body.innerHTML = svg
    rendered = true
    report()
  } catch (e) {
    if (mine === seq)
      post({
        type: 'mermaid-preview-error',
        message: (e && e.message) || String(e),
      })
  }
})
