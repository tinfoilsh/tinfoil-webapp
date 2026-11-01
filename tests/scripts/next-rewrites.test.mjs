import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * next.config.mjs is env-sensitive (dev vs production). We import it fresh
 * under each scenario and inspect the returned rewrites and headers.
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

describe('next.config.mjs', () => {
  beforeEach(() => {
    delete process.env.VERCEL
    delete process.env.CI
  })
  afterEach(() => {
    restoreEnv()
  })

  it.each([
    { dev: true, nodeEnv: 'development' },
    { dev: false, nodeEnv: 'development' },
    { dev: true, nodeEnv: 'production' },
  ])(
    'never proxies API traffic around the attested harness (dev flag $dev, $nodeEnv)',
    async ({ dev, nodeEnv }) => {
      setConfigEnv({ dev, nodeEnv })
      const cfg = await loadConfig()
      expect(cfg.rewrites).toBeUndefined()
    },
  )
})
