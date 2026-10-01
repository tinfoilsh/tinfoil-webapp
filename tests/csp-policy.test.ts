import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The deployed CSP is what WEBCAT will pin in the manifest. Keep it free of
// anything the validator rejects or that we worked to remove.
const csp = (
  JSON.parse(readFileSync('vercel.json', 'utf8')).headers[0].headers as Array<{
    key: string
    value: string
  }>
).find((h) => h.key === 'Content-Security-Policy')!.value
const directive = (name: string) =>
  csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith(name + ' ') || d === name)
    ?.slice(name.length)
    .trim()

describe('Content-Security-Policy in vercel.json', () => {
  it('allows no inline or eval and no remote script origins', () => {
    expect(csp).not.toMatch(
      /'unsafe-inline'|'unsafe-eval'|'unsafe-hashes'|'strict-dynamic'|nonce-/,
    )
    expect(directive('script-src')).toBe("'self' 'wasm-unsafe-eval'")
    expect(directive('style-src')).toBe("'self'")
    expect(directive('worker-src')).toBe("'self'")
    expect(directive('object-src')).toBe("'none'")
    expect(directive('default-src')).toBe("'self'")
  })

  it('frames only the enrolled verification center and the sandbox', () => {
    expect(directive('frame-src')?.split(/\s+/)).toEqual([
      "'self'",
      'https://verification-center.tinfoil.sh',
      'https://webapp-sandbox.tinfoil.sh',
      'https://tinfoil-webapp-sandbox-tinfoil.vercel.app',
    ])
  })

  it('has no commas, which WEBCAT rejects as multiple policies', () => {
    expect(csp).not.toContain(',')
  })
})
