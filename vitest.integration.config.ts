import path from 'path'
import { defineConfig } from 'vitest/config'

/**
 * Live integration tests against a real sync enclave.
 *
 * Gated on the `SYNC_ENCLAVE_URL` env var: when unset, every test in
 * `tests/integration/**` skips itself via `describe.skipIf`. The
 * unit-test config in `vitest.config.ts` excludes this directory so
 * `npm run test:unit` never accidentally hits the network.
 *
 * Use a longer hook timeout because attestation + the first round
 * trip can take several seconds against a freshly-spun enclave.
 */
export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    typecheck: { tsconfig: './tsconfig.test.json' },
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
