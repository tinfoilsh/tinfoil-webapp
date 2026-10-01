import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every iframe the chat renders must carry a sandbox attribute. The sandbox
// origin also sandboxes its own pages by CSP header, but the attribute is
// what keeps model-authored content opaque regardless of where it loads.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sourceFiles(p)
    return /\.(tsx|jsx)$/.test(name) ? [p] : []
  })
}

describe('iframes', () => {
  it('are all sandboxed', () => {
    const offenders: string[] = []
    for (const file of sourceFiles('src')) {
      const src = readFileSync(file, 'utf8')
      for (const match of src.matchAll(/<iframe\b[\s\S]*?(?:\/>|>)/g)) {
        if (!/\bsandbox=/.test(match[0])) {
          offenders.push(`${file}: ${match[0].split('\n')[0].slice(0, 60)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
