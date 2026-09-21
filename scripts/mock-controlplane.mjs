import { createMockSafeguardsStore } from './mock-safeguards.mjs'

/**
 * Composes local controlplane mocks behind one request router.
 *
 * Add future mock modules to `defaultMocks`; each module owns its routes,
 * state, validation, and responses and exposes a `route(req, res)` method.
 * Returning null means the request was not handled and lets the next mock or
 * the development server handle it.
 */
export function createMockControlplane({ logger = console, mocks } = {}) {
  const defaultMocks = [createMockSafeguardsStore({ logger })]
  const registeredMocks = mocks ?? defaultMocks

  return {
    route(req, res) {
      for (const mock of registeredMocks) {
        const result = mock.route(req, res)
        if (result !== null) return result
      }
      return null
    },
  }
}
