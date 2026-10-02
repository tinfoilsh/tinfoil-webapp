import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// next/font/local names each family after the const it is assigned to, and its
// `.variable` class only reaches the wrapped tree. globals.css repeats the
// values on :root for portals (Radix, toasts); keep the two in sync.
describe('font aliases on :root', () => {
  it('match the families next/font generates for _app.tsx', () => {
    const app = readFileSync('src/pages/_app.tsx', 'utf8')
    const css = readFileSync('src/styles/globals.css', 'utf8')
    const fonts = [
      ...app.matchAll(
        /const (\w+) = localFont\(\{[\s\S]*?variable: '(--font-[\w-]+)'/g,
      ),
    ]
    expect(fonts.length).toBe(4)
    for (const [, family, variable] of fonts) {
      expect(css).toContain(`${variable}: ${family}, '${family} Fallback';`)
    }
  })
})
