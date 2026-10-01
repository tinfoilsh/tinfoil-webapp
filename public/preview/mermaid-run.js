// Runs inside the Mermaid preview frame (srcdoc, opaque origin). The diagram
// source arrives as JSON data, never as code, so this document needs only
// scripts from the app origin: no inline, no eval.
const data = JSON.parse(document.getElementById('data').textContent)
const post = (m) =>
  parent.postMessage({ ...m, instanceId: data.instanceId }, '*')

try {
  const { default: mermaid } = await import(
    data.origin + '/vendor/mermaid/mermaid.esm.min.mjs'
  )
  mermaid.initialize({
    startOnLoad: false,
    theme: data.isDarkMode ? 'dark' : 'default',
    securityLevel: 'strict',
    // Labels as SVG text rather than <foreignObject>, as before.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    class: { htmlLabels: false },
  })
  const { svg } = await mermaid.render('diagram', String(data.code))
  document.body.innerHTML = svg
  const report = () =>
    post({
      type: 'mermaid-preview-height',
      height: Math.ceil(document.documentElement.scrollHeight),
    })
  report()
  new ResizeObserver(report).observe(document.body)
} catch (e) {
  post({
    type: 'mermaid-preview-error',
    message: (e && e.message) || String(e),
  })
}
