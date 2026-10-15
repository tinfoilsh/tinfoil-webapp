import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'
import { setupHarness } from './tests/harness-fixture'

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

let releaseHarness: (() => void) | undefined
beforeEach(() => {
  releaseHarness = setupHarness().release
})
afterEach(() => {
  releaseHarness?.()
})
