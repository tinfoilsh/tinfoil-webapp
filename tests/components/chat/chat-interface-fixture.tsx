// The real chat page makes no request outside the harness. Tests that render
// it replace its surroundings (Clerk, the router, projects, lazy modals, the
// sidebar) with the mocks in chat-page-mocks.tsx, which each such test file
// declares, since vi.mock is hoisted per file.
import { vi } from 'vitest'

// Rejects any fetch, and returns the stub so a test can check none was made.
export function refuseFetch() {
  const fetch = vi.fn(async (url: string) => {
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
