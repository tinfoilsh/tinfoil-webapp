// Runs inside the CSS preview frame (srcdoc, opaque origin). The stylesheet
// arrives as JSON data and is applied through the CSSOM, which CSP does not
// govern, so this document needs neither inline styles nor inline scripts.
const data = JSON.parse(document.getElementById('data').textContent)
const baseline = new CSSStyleSheet()
baseline.replaceSync(
  'body{margin:0;padding:16px;font-family:system-ui,sans-serif}',
)
const sheet = new CSSStyleSheet()
sheet.replaceSync(String(data.css))
document.adoptedStyleSheets = [baseline, sheet]
const report = () =>
  parent.postMessage(
    {
      type: 'css-preview-height',
      instanceId: data.instanceId,
      height: Math.max(document.body.scrollHeight, 150),
    },
    data.origin,
  )
window.addEventListener('load', report)
setTimeout(report, 100)
