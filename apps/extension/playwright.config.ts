import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '*.spec.ts',
  workers: 1,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  reporter: 'list',
})
