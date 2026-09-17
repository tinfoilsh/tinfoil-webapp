import {
  getSafeguardsSnapshot,
  refreshSafeguards,
  resetSafeguards,
  subscribeSafeguards,
} from '@/services/safeguards'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/auth', () => ({
  authTokenManager: {
    getAuthHeaders: vi.fn().mockResolvedValue({ Authorization: 'Bearer t' }),
  },
  AuthTokenUnavailableError: class extends Error {},
}))

vi.mock('@/config', () => ({ API_BASE_URL: 'https://api.test', IS_DEV: false }))

const RESPONSE = {
  violations: [
    { id: 'v1', conversation_id: 'chat-a', created_at: '2026-09-16T12:00:00Z' },
    { id: 'v2', conversation_id: 'chat-b', created_at: '2026-09-01T12:00:00Z' },
    { id: 'v3', conversation_id: '', created_at: '2026-08-01T12:00:00Z' },
  ],
  in_window: 1,
  window_hours: 168,
  warn_threshold: 8,
  ban_threshold: 10,
}

describe('safeguards store', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetSafeguards()
  })

  it('loads flagged chats and indexes them by conversation id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(RESPONSE)),
    )

    await refreshSafeguards()

    const snapshot = getSafeguardsSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.inWindow).toBe(1)
    expect(snapshot.banThreshold).toBe(10)
    expect(snapshot.flaggedChats.map((f) => f.conversationId)).toEqual([
      'chat-a',
      'chat-b',
      '',
    ])
    expect(snapshot.flaggedChatIds).toEqual({ 'chat-a': true, 'chat-b': true })
    expect(fetch).toHaveBeenCalledWith(
      'https://api.test/api/users/me/aup-violations',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer t' }),
      }),
    )
  })

  it('keeps the previous data and marks an error on a failed refresh', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(RESPONSE)),
    )
    await refreshSafeguards()
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('nope', { status: 500 }),
    )

    await refreshSafeguards()

    const snapshot = getSafeguardsSnapshot()
    expect(snapshot.status).toBe('error')
    expect(snapshot.flaggedChats).toHaveLength(3)
  })

  it('shares one request between concurrent refreshes', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(RESPONSE)))

    await Promise.all([refreshSafeguards(), refreshSafeguards()])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('notifies subscribers and clears on reset', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(RESPONSE)),
    )
    const listener = vi.fn()
    subscribeSafeguards(listener)

    await refreshSafeguards()
    resetSafeguards()

    expect(listener).toHaveBeenCalled()
    expect(getSafeguardsSnapshot().flaggedChats).toEqual([])
    expect(getSafeguardsSnapshot().status).toBe('idle')
  })
})
