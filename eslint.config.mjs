import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'

// eslint-config-next@16 ships a native flat config. Going through
// `FlatCompat` triggers a "Converting circular structure to JSON" crash
// in @eslint/eslintrc once ESLint 9.36+ pulls in eslint-plugin-react@7
// / eslint-plugin-react-hooks@7, so we import the flat preset directly.
//
// eslint-plugin-react-hooks@7 adds a wave of new rules (set-state-in-effect,
// refs, preserve-manual-memoization, immutability, ...). We turn those off
// to preserve the previous lint coverage; only `rules-of-hooks` (error) and
// `exhaustive-deps` (warn) stay active.
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
  ...nextCoreWebVitals,
  {
    rules: {
      '@next/next/no-img-element': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/component-hook-factories': 'off',
      'react-hooks/incompatible-library': 'off',
      'react-hooks/globals': 'off',
      'react-hooks/error-boundaries': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-render': 'off',
      'react-hooks/unsupported-syntax': 'off',
      'react-hooks/config': 'off',
      'react-hooks/gating': 'off',
      'react-hooks/use-memo': 'off',
    },
  },
  // §9.6 R2 — sync reliability contract.
  //
  // Bare `catch {}` and empty-body `catch (e) {}` blocks let server
  // and network failures vanish silently. In the cloud adapter layer
  // and the two sync hooks, `no-empty` (with `allowEmptyCatch` left
  // off) forces every catch body to at least say what it does with
  // the error, instead of swallowing it invisibly.
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
