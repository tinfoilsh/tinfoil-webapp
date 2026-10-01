import { SANDBOX_ORIGIN } from '@/config'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The deployed CSP is what WEBCAT will pin in the manifest. Keep it free of
// anything the validator rejects or that we worked to remove.
type HeaderBlock = {
  source: string
  headers: Array<{ key: string; value: string }>
}
const blocks = JSON.parse(readFileSync('vercel.json', 'utf8'))
  .headers as HeaderBlock[]
const cspOf = (block: HeaderBlock) =>
  block.headers.find((h) => h.key === 'Content-Security-Policy')!.value
const csp = cspOf(blocks[0])
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

  it('has no -elem / -attr overrides that could loosen the base directives', () => {
    expect(csp).not.toMatch(/\b(script|style)-src-(elem|attr)\b/)
  })

  it('frames the sandbox origin the app is configured to use', () => {
    expect(directive('frame-src')?.split(/\s+/)).toContain(SANDBOX_ORIGIN)
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

  it('gives only the Mermaid page a policy with inline styles (WEBCAT extra_csp)', () => {
    const page = '/preview/mermaid.html'
    expect(existsSync('public' + page)).toBe(true)
    const [block, ...more] = blocks.filter(
      (b) =>
        b !== blocks[0] &&
        b.headers.some((h) => h.key === 'Content-Security-Policy'),
    )
    expect(more).toEqual([])
    expect(block).toBeDefined()
    expect(block.source).toBe(page)
    const mermaidCsp = cspOf(block)
    expect(mermaidCsp.startsWith("default-src 'none'; ")).toBe(true)
    const scriptSrc = mermaidCsp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('script-src '))
    expect(scriptSrc).toBe("script-src 'self'")
    expect(mermaidCsp).toContain("style-src 'unsafe-inline'")
    expect(mermaidCsp).toContain('sandbox allow-scripts')
    expect(mermaidCsp).not.toMatch(/'unsafe-eval'|'unsafe-hashes'|https?:|,/)
  })
})
