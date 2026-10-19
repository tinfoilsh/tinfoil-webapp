import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// scripts/patch-style-singleton.mjs (postinstall and prebuild) rewrites the
// scroll-lock helper Radix uses so its CSS goes through adoptedStyleSheets
// instead of a <style> element, which style-src 'self' would block.
describe('react-style-singleton', () => {
  it.each(['es2015', 'es5'])('%s build is patched', (dir) => {
    const src = readFileSync(
      `node_modules/react-style-singleton/dist/${dir}/singleton.js`,
      'utf8',
    )
    expect(src).toContain('adoptedStyleSheets')
    expect(src).toContain('function insertStyleTag(tag) {}')
    const exports: {
      stylesheetSingleton?: () => {
        add: (css: string) => void
        remove: () => void
      }
    } = {}
    runInNewContext(
      ts.transpileModule(src, {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
      }).outputText,
      {
        exports,
        require: createRequire(import.meta.url),
        document,
        CSSStyleSheet,
      },
    )
    const existing = [...document.adoptedStyleSheets]
    const sentinel = new CSSStyleSheet()
    const styleCount = document.querySelectorAll('style').length
    document.adoptedStyleSheets = [sentinel]
    try {
      const singleton = exports.stylesheetSingleton!()
      singleton.add('body { overflow: hidden; }')
      singleton.add('body { overflow: hidden; }')
      expect(document.adoptedStyleSheets).toHaveLength(2)
      expect(document.adoptedStyleSheets[0]).toBe(sentinel)
      const rule = document.adoptedStyleSheets[1].cssRules[0] as CSSStyleRule
      expect(rule.style.getPropertyValue('overflow')).toBe('hidden')
      expect(document.querySelectorAll('style')).toHaveLength(styleCount)
      singleton.remove()
      expect(document.adoptedStyleSheets).toHaveLength(2)
      singleton.remove()
      expect(document.adoptedStyleSheets).toEqual([sentinel])
    } finally {
      document.adoptedStyleSheets = existing
    }
  })
})
