import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * next.config.mjs is env-sensitive (dev vs hosted, controlplane URL). We
 * import it fresh under each scenario and inspect the returned rewrites.
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'

const CONFIG_PATH = path.resolve(process.cwd(), 'next.config.mjs')
const CONTROLPLANE_URL = 'https://api.tinfoil.sh'
let configImportSequence = 0

async function loadConfig() {
  // Bust the ESM cache with a real filesystem URL + guaranteed-unique query
  // so Vite doesn't rewrite the specifier or reuse prior environment state.
  const url = `${pathToFileURL(CONFIG_PATH).href}?nocache=${configImportSequence++}`
  const mod = await import(/* @vite-ignore */ url)
  return mod.default
}

const ORIGINAL_ENV = { ...process.env }

function setConfigEnv({ dev = true, nodeEnv = 'development' } = {}) {
  process.env.NODE_ENV = nodeEnv
  process.env.NEXT_PUBLIC_API_BASE_URL = CONTROLPLANE_URL
  if (dev) process.env.NEXT_PUBLIC_DEV = 'true'
  else delete process.env.NEXT_PUBLIC_DEV
}

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
    setConfigEnv()
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
    setConfigEnv({ dev: false, nodeEnv: 'production' })
    const cfg = await loadConfig()
    const rules = await cfg.rewrites()
    expect(rules).toEqual([])
  })

  it('does not enable the proxy in next dev without the explicit Tinfoil dev flag', async () => {
    setConfigEnv({ dev: false })
    const cfg = await loadConfig()
    expect(await cfg.rewrites()).toEqual([])
  })

  it('refuses NEXT_PUBLIC_DEV=true in a hosted build', async () => {
    setConfigEnv()
    process.env.VERCEL = '1'
    await expect(loadConfig()).rejects.toThrow(/NEXT_PUBLIC_DEV=true/)
  })
})
