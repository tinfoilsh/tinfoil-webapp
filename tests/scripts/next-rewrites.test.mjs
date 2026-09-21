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

  it('sends local-router traffic directly and all other APIs through the local gateway', async () => {
    process.env.NODE_ENV = 'development'
    process.env.NEXT_PUBLIC_DEV = 'true'
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.tinfoil.sh'
    const cfg = await loadConfig()

    expect(await cfg.rewrites()).toEqual([
      {
        source: '/api/local-router/:path*',
        destination: 'http://localhost:8090/:path*',
      },
      {
        source: '/api/:path*',
        destination: 'http://localhost:3001/api/:path*',
      },
    ])
  })

  it('omits the catch-all outside of dev so hosted builds never proxy /api/* through the frontend', async () => {
    delete process.env.NEXT_PUBLIC_DEV
    process.env.NODE_ENV = 'production'
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.tinfoil.sh'
    const cfg = await loadConfig()
    const rules = await cfg.rewrites()
    expect(rules).toEqual([])
  })

  it('does not enable the proxy in next dev without the explicit Tinfoil dev flag', async () => {
    process.env.NODE_ENV = 'development'
    delete process.env.NEXT_PUBLIC_DEV
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.tinfoil.sh'
    const cfg = await loadConfig()
    expect(await cfg.rewrites()).toEqual([])
  })

  it('refuses NEXT_PUBLIC_DEV=true in a hosted build', async () => {
    process.env.VERCEL = '1'
    process.env.NEXT_PUBLIC_DEV = 'true'
    await expect(loadConfig()).rejects.toThrow(/NEXT_PUBLIC_DEV=true/)
  })
})
