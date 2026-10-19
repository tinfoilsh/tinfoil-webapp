// A fake harness for tests that render the real chat page. The page's
// surroundings (Clerk, the router, projects, lazy modals, the sidebar) are
// replaced by the mocks in chat-page-mocks.tsx, which each such test file
// declares, since vi.mock is hoisted per file.
import { AUTH_ACTIVE_USER_ID } from '@/constants/storage-keys'
import type { HarnessClient } from '@/services/harness/client'
import { activateAPI, HarnessAPI, publish } from '@/services/harness/runtime'
import type { Session } from '@/services/harness/types'
import { vi } from 'vitest'
import { testSession } from '../../harness-fixture'

export const KEY = 'Y29udGVudC1rZXk='

export interface FakeHarness {
  api: HarnessAPI
  client: {
    ready: ReturnType<typeof vi.fn>
    events: ReturnType<typeof vi.fn>
    post: ReturnType<typeof vi.fn>
    upload: ReturnType<typeof vi.fn>
    download: ReturnType<typeof vi.fn>
    stream: ReturnType<typeof vi.fn>
  }
}

// Activates a harness API for the account, as HarnessProvider does.
export function connectHarness({
  userId = 'alice',
  cloud = true,
  session = {},
  profile = {},
}: {
  userId?: string | null
  cloud?: boolean
  session?: Partial<Session>
  profile?: Record<string, unknown>
} = {}): FakeHarness {
  if (userId) localStorage.setItem(AUTH_ACTIVE_USER_ID, userId)
  localStorage.setItem(
    'tinfoil-settings-cloud-sync-enabled',
    cloud ? 'true' : 'false',
  )
  const client = {
    ready: vi.fn().mockResolvedValue(undefined),
    events: vi.fn(),
    post: vi.fn().mockResolvedValue({}),
    upload: vi.fn(),
    download: vi.fn(),
    stream: vi.fn(),
  }
  const api = new HarnessAPI(client as unknown as HarnessClient, userId)
  if (userId) vi.spyOn(api, 'key').mockReturnValue(KEY)
  activateAPI(api)
  publish({
    session: { ...testSession, ...session },
    profile,
    keyReady: true,
    profileReady: true,
  })
  return { api, client }
}
