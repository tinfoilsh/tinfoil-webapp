import { readFileSync } from 'node:fs'
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
  })
})
