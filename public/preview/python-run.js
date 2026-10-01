// Runs inside the Python preview frame (srcdoc, opaque origin). User code
// arrives as JSON data and executes in Pyodide (WebAssembly), so this
// document needs only scripts from the app origin plus 'wasm-unsafe-eval'.
const data = JSON.parse(document.getElementById('data').textContent)
const post = (m) =>
  parent.postMessage({ ...m, instanceId: data.instanceId }, '*')
const output = []

post({ type: 'python-preview-loading' })
try {
  const { loadPyodide } = await import(
    data.origin + '/vendor/pyodide/pyodide.mjs'
  )
  const pyodide = await loadPyodide({
    indexURL: data.origin + '/vendor/pyodide/',
  })
  pyodide.runPython(
    'import sys\nfrom io import StringIO\nsys.stdout = StringIO()\nsys.stderr = StringIO()',
  )
  try {
    const result = pyodide.runPython(String(data.code))
    const stdout = pyodide.runPython('sys.stdout.getvalue()')
    const stderr = pyodide.runPython('sys.stderr.getvalue()')
    if (stdout)
      stdout
        .split('\n')
        .filter((l) => l)
        .forEach((l) => output.push(l))
    if (stderr)
      stderr
        .split('\n')
        .filter((l) => l)
        .forEach((l) => output.push('Error: ' + l))
    if (result !== undefined && result !== null && !stdout) {
      const s = String(result)
      if (s !== 'None') output.push('→ ' + s)
    }
  } catch (e) {
    output.push('Error: ' + (e.message || String(e) || 'Unknown error'))
  }
} catch (e) {
  output.push(
    'Error loading Python: ' + (e.message || String(e) || 'Unknown error'),
  )
}
post({ type: 'python-preview-output', output })
