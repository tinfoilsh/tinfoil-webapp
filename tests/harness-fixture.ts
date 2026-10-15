import type { HarnessClient } from '@/services/harness/client'
import { activateAPI, HarnessAPI, publish } from '@/services/harness/runtime'
import type { Session } from '@/services/harness/types'
import { vi } from 'vitest'

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
export function setupHarness() {
  const client = {
    post: vi
      .fn()
      .mockImplementation(async (path: string) =>
        path === '/v1/session' ? structuredClone(testSession) : {},
      ),
    events: vi.fn(),
    upload: vi.fn(),
    download: vi.fn(),
  }
  const api = new HarnessAPI(client as unknown as HarnessClient, null)
  const release = activateAPI(api)
  publish({ session: testSession, keyReady: true })
  return { api, client, release }
}
