import {
  AUTH_ACTIVE_USER_ID,
  SETTINGS_CLOUD_SYNC_ENABLED,
} from '@/constants/storage-keys'
import type { HarnessClient } from '@/services/harness/client'
import { activateAPI, HarnessAPI, publish } from '@/services/harness/runtime'
import type { Session } from '@/services/harness/types'
import { vi, type Mock } from 'vitest'

export const KEY = 'Y29udGVudC1rZXk='

export const testSession: Session = {
  user: { id: '', anonymous: true },
  defaultModel: 'test-model',
  models: [
    { id: 'test-model', name: 'Test model', multimodal: true, reasoning: null },
  ],
  auto: {
    multimodal: false,
    default: 'high',
    levels: ['instant', 'low', 'medium', 'high', 'extra', 'max'].map(
      (id, index) => ({
        id,
        label: id[0].toUpperCase() + id.slice(1),
        value: index * 20,
      }),
    ),
  },
  key: { registered: false, keyId: null, bundles: [] },
  presets: [],
  widgets: [],
  rateLimit: { kind: null, maxRequests: 100, remaining: 100 },
  features: {
    webSearch: true,
    codeExecution: true,
    transcription: true,
    speech: true,
    genUI: true,
    sandbox: true,
    piiCheck: true,
    memory: true,
  },
  upload: {
    accept: ['.txt', '.png'],
    maxBytes: 1000000,
    maxTextBytes: 1000000,
  },
}

// The harness's answer to /v1/keys/migrate-all: the sync service's newly
// started migration job.
export const MIGRATION_STARTED = {
  job_id: 'job-1',
  status: 'running',
  started_at: '2026-04-01T09:00:00Z',
  updated_at: '2026-04-01T09:00:00Z',
  migrated: 0,
  retryable_remaining: 0,
  blocked_unmigrated: 0,
  partial: true,
  scopes: [],
}

export interface FakeClient {
  ready: Mock
  events: Mock
  post: Mock
  upload: Mock
  download: Mock
  stream: Mock
}

function unexpected(path: string): never {
  throw new Error(`Unexpected harness request: ${path}`)
}

// The client of the harness the last sign-in activated. It rejects every
// request until the test scripts it.
export let client: FakeClient

// Signs an account in to a fake harness, as HarnessProvider does. The
// account's content key is unlocked unless `locked`; a signed-out visitor
// has none.
export function signIn({
  userId = 'alice',
  cloud = false,
  locked = false,
  session = testSession,
  profile = {},
}: {
  userId?: string | null
  cloud?: boolean
  locked?: boolean
  session?: Session
  profile?: Record<string, unknown>
} = {}) {
  if (userId) {
    localStorage.setItem(AUTH_ACTIVE_USER_ID, userId)
    localStorage.setItem(SETTINGS_CLOUD_SYNC_ENABLED, String(cloud))
  }
  client = {
    ready: vi.fn(async () => {}),
    events: vi.fn(async function* (path: string): AsyncGenerator<never> {
      unexpected(path)
    }),
    post: vi.fn(async (path: string) => unexpected(path)),
    upload: vi.fn(async (path: string) => unexpected(path)),
    download: vi.fn(async (path: string) => unexpected(path)),
    stream: vi.fn(async (path: string) => unexpected(path)),
  }
  const api = new HarnessAPI(client as unknown as HarnessClient, userId)
  const unlocked = !!userId && !locked
  if (unlocked) vi.spyOn(api, 'key').mockReturnValue(KEY)
  activateAPI(api)
  publish({
    session,
    profile,
    keyReady: unlocked || !userId,
    profileReady: true,
  })
  return api
}
