import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'

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
]

export default eslintConfig
