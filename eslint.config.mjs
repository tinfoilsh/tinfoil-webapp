import { FlatCompat } from '@eslint/eslintrc'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({
  baseDirectory: __dirname,
})

const eslintConfig = [
  {
    ignores: [
      '.next/**',
      '.vercel/**',
      'out/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  ...compat.extends('next/core-web-vitals'),
  {
    rules: {
      '@next/next/no-img-element': 'off',
    },
  },
  // §9.6 R2 — sync reliability contract.
  //
  // Bare `catch {}` and empty-body `catch (e) {}` blocks let server
  // and network failures vanish silently. Every catch in the cloud
  // adapter layer and in the two sync hooks must route through
  // `classifyEnclaveError` (or re-throw); the built-in `no-empty`
  // rule enforces this once `allowEmptyCatch` is left off.
  {
    files: [
      'src/services/cloud/**/*.ts',
      'src/services/cloud/**/*.tsx',
      'src/hooks/use-cloud-sync.ts',
      'src/hooks/use-passkey-backup.ts',
    ],
    rules: {
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
]

export default eslintConfig
