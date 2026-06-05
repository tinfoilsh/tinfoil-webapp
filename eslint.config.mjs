import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import i18next from 'eslint-plugin-i18next'

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
      // Advisory rules introduced in eslint-plugin-react-hooks v6 that target
      // React Compiler readiness. They flag patterns that are not bugs in
      // current behavior; surface them as warnings so they show up in editors
      // without blocking CI on every pre-Compiler call site.
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
  {
    // Surface (without blocking CI) any hardcoded user-facing JSX text in the
    // UI so new strings get routed through the i18n catalogs. Translate with
    // useTranslation()/t() and add the key to src/i18n/locales/<lng>/*.json.
    files: ['src/components/**/*.{ts,tsx}', 'src/pages/**/*.{ts,tsx}'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': ['warn', { mode: 'jsx-text-only' }],
    },
  },
]

export default eslintConfig
