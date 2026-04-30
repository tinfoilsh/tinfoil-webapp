/**
 * Polyfills injected into HTML artifacts before the model-authored markup
 * runs. Artifact iframes are deliberately sandboxed without
 * `allow-same-origin`, which means accessing `window.localStorage`,
 * `window.sessionStorage`, or `document.cookie` throws a `SecurityError`.
 * Naive code that touches these APIs at the top of a `<script>` aborts the
 * entire script tag, leaving an inert page (no event listeners attached,
 * buttons do nothing).
 *
 * To keep AI-generated artifacts robust we shim the throwing browser APIs
 * with in-memory equivalents that live for the lifetime of the iframe. The
 * shims expose the same surface as the native objects so unmodified code
 * can read and write without crashing.
 */

const POLYFILL_SCRIPT = `<script>(function(){
try {
  function createMemoryStorage(){
    var store = Object.create(null);
    return {
      getItem: function(key){ return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
      setItem: function(key, value){ store[String(key)] = String(value); },
      removeItem: function(key){ delete store[String(key)]; },
      clear: function(){ store = Object.create(null); },
      key: function(index){ var keys = Object.keys(store); return index >= 0 && index < keys.length ? keys[index] : null; },
      get length(){ return Object.keys(store).length; },
    };
  }
  function installStorage(name){
    try { var probe = window[name]; if (probe && typeof probe.getItem === 'function') { probe.getItem('__tinfoil_probe__'); return; } } catch (_) {}
    try { Object.defineProperty(window, name, { value: createMemoryStorage(), configurable: true, writable: true }); } catch (_) {}
  }
  installStorage('localStorage');
  installStorage('sessionStorage');
  try { document.cookie; } catch (_) {
    try { Object.defineProperty(document, 'cookie', { get: function(){ return ''; }, set: function(){}, configurable: true }); } catch (__) {}
  }
} catch (_) {}
})();</script>`

/**
 * Returns the artifact HTML with polyfill shims injected as early as
 * possible. Handles full documents (inserts before the first `<script>` or
 * `</head>`) and bare fragments (prepended).
 */
export function injectArtifactPolyfills(html: string): string {
  if (!html) return html

  const headCloseMatch = html.match(/<\/head\s*>/i)
  if (headCloseMatch && headCloseMatch.index !== undefined) {
    return (
      html.slice(0, headCloseMatch.index) +
      POLYFILL_SCRIPT +
      html.slice(headCloseMatch.index)
    )
  }

  const bodyOpenMatch = html.match(/<body[^>]*>/i)
  if (bodyOpenMatch && bodyOpenMatch.index !== undefined) {
    const insertAt = bodyOpenMatch.index + bodyOpenMatch[0].length
    return html.slice(0, insertAt) + POLYFILL_SCRIPT + html.slice(insertAt)
  }

  return POLYFILL_SCRIPT + html
}
