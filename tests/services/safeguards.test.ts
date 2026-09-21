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

vi.mock('@/config', () => ({ API_BASE_URL: 'https://api.test' }))

const RESPONSE = {
  flags: [
    { id: 'v1', conversation_id: 'chat-a', created_at: '2026-09-16T12:00:00Z' },
    { id: 'v2', conversation_id: 'chat-b', created_at: '2026-09-01T12:00:00Z' },
    { id: 'v3', conversation_id: '', created_at: '2026-08-01T12:00:00Z' },
  ],
  in_window: 1,
  window_hours: 168,
  warn_threshold: 8,
  ban_threshold: 10,
}

// A fetch mock whose response the test controls, plus a `called` promise that
// settles only when the code under test actually invokes fetch, so the test
// can order a reset relative to the network call without guessing at awaits.
function deferredFetch() {
  let resolve: (response: Response) => void = () => {}
  let markCalled: () => void = () => {}
  const called = new Promise<void>((r) => {
    markCalled = r
  })
  const response = new Promise<Response>((r) => {
    resolve = r
  })
  const impl = () => {
    markCalled()
    return response
  }
  return { impl, resolve, called }
}

describe('safeguards store', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetSafeguards()
  })

  it('has no simulator or preview surface on the exported store', async () => {
    const mod = await import('@/services/safeguards')
    expect(mod).not.toHaveProperty('simulateSafeguardFlag')
    expect(getSafeguardsSnapshot()).not.toHaveProperty('isPreview')
  })

  it('always fetches the configured API base URL', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(RESPONSE)))
    await refreshSafeguards()
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.test/api/users/me/safeguard-flags',
      expect.any(Object),
    )
  })

  it('loads flagged chats and indexes them by conversation id', async () => {
    expect(getSafeguardsSnapshot().hasLoaded).toBe(false)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(RESPONSE)),
    )

    await refreshSafeguards()

    const snapshot = getSafeguardsSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.hasLoaded).toBe(true)
    expect(snapshot.policy).toEqual({
      inWindow: 1,
      windowHours: 168,
      warnThreshold: 8,
      banThreshold: 10,
    })
    expect(snapshot.flaggedChats.map((f) => f.conversationId)).toEqual([
      'chat-a',
      'chat-b',
      '',
    ])
    expect(snapshot.flaggedChatIds).toEqual({ 'chat-a': true, 'chat-b': true })
    expect(fetch).toHaveBeenCalledWith(
      'https://api.test/api/users/me/safeguard-flags',
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
    expect(snapshot.hasLoaded).toBe(true)
    expect(snapshot.flaggedChats).toHaveLength(3)
  })

  it('shares one request between concurrent refreshes', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(RESPONSE)))

    await Promise.all([refreshSafeguards(), refreshSafeguards()])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects a response missing policy fields instead of publishing it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ flags: RESPONSE.flags })),
    )

    await refreshSafeguards()

    const snapshot = getSafeguardsSnapshot()
    expect(snapshot.status).toBe('error')
    expect(snapshot.hasLoaded).toBe(false)
    expect(snapshot.policy).toBeNull()
    expect(snapshot.flaggedChats).toEqual([])
  })

  it('discards a response that arrives after a reset', async () => {
    const deferred = deferredFetch()
    vi.spyOn(globalThis, 'fetch').mockImplementation(deferred.impl)

    const pending = refreshSafeguards()
    await deferred.called
    resetSafeguards()
    deferred.resolve(new Response(JSON.stringify(RESPONSE)))
    await pending

    expect(getSafeguardsSnapshot().flaggedChats).toEqual([])
    expect(getSafeguardsSnapshot().status).toBe('idle')
  })

  it('lets a refresh started after a reset complete normally', async () => {
    const deferred = deferredFetch()
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(deferred.impl)
      .mockResolvedValueOnce(new Response(JSON.stringify(RESPONSE)))

    const first = refreshSafeguards()
    await deferred.called
    resetSafeguards()
    const second = refreshSafeguards()
    deferred.resolve(
      new Response(JSON.stringify({ ...RESPONSE, in_window: 9 })),
    )
    await Promise.all([first, second])

    expect(getSafeguardsSnapshot().status).toBe('ready')
    expect(getSafeguardsSnapshot().policy?.inWindow).toBe(1)
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
