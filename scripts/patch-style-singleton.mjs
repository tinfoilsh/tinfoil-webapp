// react-style-singleton (used by react-remove-scroll, which Radix Dialog and
// Select mount) injects its scroll-lock CSS as a <style> text node, which
// style-src 'self' blocks. On every install this rewrites both builds to put
// the CSS into a constructed stylesheet via document.adoptedStyleSheets,
// which CSP does not govern, and to insert no <style> element at all (even an
// empty one is reported as inline style). Idempotent; fails loudly if the
// library's structure changed.
import fs from 'node:fs'

const FILES = [
  'node_modules/react-style-singleton/dist/es2015/singleton.js',
  'node_modules/react-style-singleton/dist/es5/singleton.js',
]
const INJECT = /function injectStyles\(tag, css\) \{[\s\S]*?\n\}/
const INSERT = /function insertStyleTag\(tag\) \{[\s\S]*?\n\}/
const REMOVE =
  /stylesheet\.parentNode && stylesheet\.parentNode\.removeChild\(stylesheet\);/

for (const file of FILES) {
  let src = fs.readFileSync(file, 'utf8')
  if (src.includes('adoptedStyleSheets')) continue
  if (
    !INJECT.test(src) ||
    !INSERT.test(src) ||
    !REMOVE.test(src) ||
    !src.includes('createTextNode(css)')
  ) {
    throw new Error(
      `${file}: unexpected structure, cannot patch style injection`,
    )
  }
  src = src
    .replace(
      INJECT,
      `function injectStyles(tag, css) {
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    tag.__sheet = sheet;
    document.adoptedStyleSheets = document.adoptedStyleSheets.concat(sheet);
}`,
    )
    .replace(INSERT, 'function insertStyleTag(tag) {}')
    .replace(
      REMOVE,
      `document.adoptedStyleSheets = document.adoptedStyleSheets.filter(function (s) { return s !== stylesheet.__sheet; });`,
    )
  fs.writeFileSync(file, src)
}
console.log(
  'react-style-singleton: scroll-lock CSS via adoptedStyleSheets, no <style> element',
)
