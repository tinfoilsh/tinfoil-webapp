import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'

// Mock localStorage for tests
const localStorageMock = (() => {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(String(key)) ?? null,
    setItem: (key: string, value: string) => {
      store.set(String(key), String(value))
    },
    removeItem: (key: string) => {
      store.delete(String(key))
    },
    clear: () => {
      store.clear()
    },
    get length() {
      return store.size
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
  }
})()

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
})

// Reset localStorage before each test
beforeEach(() => {
  localStorage.clear()
})

// Imported per test rather than with this file, so that the harness runtime
// and its dependencies load after a test file's mocks are registered.
let releaseHarness: (() => void) | undefined
beforeEach(async () => {
  const { setupHarness } = await import('./tests/harness-fixture')
  releaseHarness = setupHarness().release
})
afterEach(() => {
  releaseHarness?.()
})
