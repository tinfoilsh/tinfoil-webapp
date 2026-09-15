import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'
import { setupHarness } from './tests/harness-fixture'

// Mock localStorage for tests
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    clear: () => {
      store = {}
    },
    get length() {
      return Object.keys(store).length
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
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
