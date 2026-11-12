import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['../../vitest.setup.ts'],
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
})
