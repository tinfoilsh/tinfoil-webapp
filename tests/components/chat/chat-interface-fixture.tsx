// The one request the real chat page makes outside the harness, for tests
// that render it. The page's surroundings (Clerk, the router, projects, lazy
// modals, the sidebar) are replaced by the mocks in chat-page-mocks.tsx,
// which each such test file declares, since vi.mock is hoisted per file.
import { vi } from 'vitest'

// The account's safeguard flags, as the page fetches them.
export function safeguardFlags(flags: { conversation_id: string }[] = []) {
  return Response.json({
    flags: flags.map((flag, index) => ({
      id: `flag-${index}`,
      created_at: '2026-04-01T10:00:00Z',
      ...flag,
    })),
    in_window: flags.length,
    window_hours: 168,
    warn_threshold: 2,
    ban_threshold: 3,
  })
}

// Answers the page's safeguard flags request and rejects any other fetch.
export function stubSafeguardFlags(
  respond: () => Response | Promise<Response> = () => safeguardFlags(),
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/users/me/safeguard-flags'))
        return respond()
      throw new Error(`Unexpected request: ${url}`)
    }),
  )
}
