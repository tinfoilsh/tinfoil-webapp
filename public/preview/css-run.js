// Runs inside the CSS preview frame (srcdoc, opaque origin): reports the
// rendered height of the sample markup. The stylesheet itself is a <style>
// element in the document, which needs no script permission.
const data = JSON.parse(document.getElementById('data').textContent)
const report = () =>
  parent.postMessage(
    {
      type: 'css-preview-height',
      instanceId: data.instanceId,
      height: Math.max(document.body.scrollHeight, 150),
    },
    '*',
  )
window.addEventListener('load', report)
setTimeout(report, 100)
