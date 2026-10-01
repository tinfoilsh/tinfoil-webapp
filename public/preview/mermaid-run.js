// Runs inside the Mermaid preview frame (srcdoc, opaque origin). The diagram
// source arrives as JSON data, never as code, so this document needs only
// scripts from the app origin: no inline, no eval.
const data = JSON.parse(document.getElementById('data').textContent)
const post = (m) =>
  parent.postMessage({ ...m, instanceId: data.instanceId }, data.origin)

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
  // Mermaid styles its SVG with a <style> element and style="" attributes,
  // both of which CSP blocks without 'unsafe-inline'. Re-apply them through
  // the CSSOM, which CSP does not govern. The attribute values are read from
  // a detached parse first: Firefox blanks a blocked attribute in the live
  // document, so there would be nothing left to read afterwards.
  const detached = new DOMParser().parseFromString(svg, 'text/html')
  const inlineStyles = [...detached.querySelectorAll('[style]')].map((el) =>
    el.getAttribute('style'),
  )
  document.body.innerHTML = svg
  const sheets = []
  for (const el of document.querySelectorAll('style')) {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(el.textContent)
    sheets.push(sheet)
    el.remove()
  }
  const layout = new CSSStyleSheet()
  layout.replaceSync(
    'body{margin:0;display:flex;justify-content:center;background:transparent}svg{max-width:100%;height:auto}',
  )
  document.adoptedStyleSheets = [layout, ...sheets]
  // Firefox blanks the root's style attribute while Mermaid is still
  // rendering, so derive the max-width Mermaid intended from the viewBox.
  const root = document.querySelector('svg')
  if (root && root.viewBox.baseVal.width && !inlineStyles[0]) {
    root.style.setProperty('max-width', root.viewBox.baseVal.width + 'px')
  }
  document.querySelectorAll('[style]').forEach((el, i) => {
    for (const decl of (inlineStyles[i] || '').split(';')) {
      const at = decl.indexOf(':')
      if (at > 0)
        el.style.setProperty(
          decl.slice(0, at).trim(),
          decl.slice(at + 1).trim(),
        )
    }
  })
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
