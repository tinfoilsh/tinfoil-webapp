import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * next.config.mjs is env-sensitive (dev vs hosted, controlplane URL). We
 * import it fresh under each scenario and inspect the returned rewrites.
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'

const CONFIG_PATH = path.resolve(process.cwd(), 'next.config.mjs')

async function loadConfig() {
  // Bust the ESM cache with a real filesystem URL + query so Vite doesn't
  // rewrite the specifier.
  const url = `${pathToFileURL(CONFIG_PATH).href}?nocache=${Date.now()}`
  const mod = await import(/* @vite-ignore */ url)
  return mod.default
}

const ORIGINAL_ENV = { ...process.env }

function restoreEnv() {
  for (const key of [
    'NEXT_PUBLIC_DEV',
    'NEXT_PUBLIC_API_BASE_URL',
    'VERCEL',
    'CI',
    'NODE_ENV',
  ]) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = ORIGINAL_ENV[key]
  }
}

describe('next.config.mjs rewrites', () => {
  beforeEach(() => {
    delete process.env.VERCEL
    delete process.env.CI
  })
  afterEach(() => {
    restoreEnv()
  })

  it('installs the catch-all controlplane rewrite in dev, after the specific routes', async () => {
    process.env.NEXT_PUBLIC_DEV = 'true'
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.tinfoil.sh'
    const cfg = await loadConfig()
    const rules = await cfg.rewrites()
    const sources = rules.map((r) => r.source)
    // Specific routes come first; the catch-all is last.
    expect(sources).toEqual([
      '/api/dev/simulator',
      '/api/dev/safeguard-flags',
      '/api/local-router/:path*',
      '/api/users/me/safeguard-flags',
      '/api/:path*',
    ])
    expect(rules.at(-1).destination).toBe('https://api.tinfoil.sh/api/:path*')
  })

  it('omits the catch-all outside of dev so hosted builds never proxy /api/* through the frontend', async () => {
    delete process.env.NEXT_PUBLIC_DEV
    process.env.NODE_ENV = 'production'
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.tinfoil.sh'
    const cfg = await loadConfig()
    const rules = await cfg.rewrites()
    expect(rules.map((r) => r.source)).not.toContain('/api/:path*')
    // But still declares the specific dev rewrites (harmless in static export).
    expect(rules.map((r) => r.source)).toContain(
      '/api/users/me/safeguard-flags',
    )
  })

  it('omits the catch-all when NEXT_PUBLIC_API_BASE_URL is not configured', async () => {
    process.env.NEXT_PUBLIC_DEV = 'true'
    delete process.env.NEXT_PUBLIC_API_BASE_URL
    const cfg = await loadConfig()
    const rules = await cfg.rewrites()
    expect(rules.map((r) => r.source)).not.toContain('/api/:path*')
  })

  it('rejects a malformed NEXT_PUBLIC_API_BASE_URL rather than building a bad rewrite', async () => {
    process.env.NEXT_PUBLIC_DEV = 'true'
    process.env.NEXT_PUBLIC_API_BASE_URL = 'not a url'
    const cfg = await loadConfig()
    const rules = await cfg.rewrites()
    expect(rules.map((r) => r.source)).not.toContain('/api/:path*')
  })

  it('refuses NEXT_PUBLIC_DEV=true in a hosted build', async () => {
    process.env.VERCEL = '1'
    process.env.NEXT_PUBLIC_DEV = 'true'
    await expect(loadConfig()).rejects.toThrow(/NEXT_PUBLIC_DEV=true/)
  })
})
