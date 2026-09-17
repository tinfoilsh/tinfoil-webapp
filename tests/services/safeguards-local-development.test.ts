import {
  getSafeguardsSnapshot,
  refreshSafeguards,
  resetSafeguards,
  simulateSafeguardFlag,
} from '@/services/safeguards'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/config', () => ({ API_BASE_URL: 'https://api.test', IS_DEV: false }))
vi.mock('@/constants/dev-simulator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/constants/dev-simulator')>()),
  DEV_SIMULATOR_ENABLED: true,
}))
vi.mock('@/services/auth', () => ({
  authTokenManager: {
    getAuthHeaders: vi
      .fn()
      .mockResolvedValue({ Authorization: 'Bearer token' }),
  },
  AuthTokenUnavailableError: class extends Error {},
}))

const ACCOUNT_FLAGS = {
  flags: [
    {
      id: 'flag-id',
      conversation_id: 'account-chat',
      created_at: '2026-09-17T00:00:00Z',
    },
  ],
  in_window: 1,
  window_hours: 168,
  warn_threshold: 8,
  ban_threshold: 10,
}

describe('safeguards in development without NEXT_PUBLIC_DEV', () => {
  beforeEach(() => {
    resetSafeguards()
  })
  afterEach(() => {
    resetSafeguards()
    vi.restoreAllMocks()
  })

  it('reads real account flags until the local preview is explicitly activated', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(ACCOUNT_FLAGS)))
    await refreshSafeguards()
    expect(getSafeguardsSnapshot().isPreview).toBe(false)
    expect(getSafeguardsSnapshot().flaggedChatIds).toEqual({
      'account-chat': true,
    })

    expect(simulateSafeguardFlag('preview-chat')).toBe(true)
    await refreshSafeguards()
    expect(getSafeguardsSnapshot().isPreview).toBe(true)
    expect(getSafeguardsSnapshot().flaggedChatIds).toEqual({
      'preview-chat': true,
    })
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('does not let an earlier account request overwrite the newly selected preview', async () => {
    let resolveResponse!: (response: Response) => void
    let notifyStarted!: () => void
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      notifyStarted()
      return response
    })

    const pending = refreshSafeguards()
    await started
    simulateSafeguardFlag('preview-chat')
    resolveResponse(new Response(JSON.stringify(ACCOUNT_FLAGS)))
    await pending

    expect(getSafeguardsSnapshot().isPreview).toBe(true)
    expect(getSafeguardsSnapshot().flaggedChatIds).toEqual({
      'preview-chat': true,
    })
    expect(getSafeguardsSnapshot().policy?.inWindow).toBe(1)
  })
})
