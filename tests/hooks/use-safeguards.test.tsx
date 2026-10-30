import { useSafeguardsReset } from '@/hooks/use-safeguards'
import {
  getSafeguardsSnapshot,
  refreshSafeguards,
  resetSafeguards,
} from '@/services/safeguards'
import { renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const useAuth = vi.hoisted(() => vi.fn())

vi.mock('@clerk/react', () => ({ useAuth }))
vi.mock('@/services/auth', () => ({
  authTokenManager: {
    getAuthHeaders: vi.fn().mockResolvedValue({ Authorization: 'Bearer t' }),
  },
  AuthTokenUnavailableError: class extends Error {},
}))

beforeEach(() => {
  resetSafeguards()
})

it("drops an account's flagged chats once another signs in", async () => {
  useAuth.mockReturnValue({ userId: 'user-1' })
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      flags: [
        {
          id: 'v1',
          conversation_id: 'chat-a',
          created_at: '2026-09-16T12:00:00Z',
        },
      ],
      in_window: 1,
      window_hours: 168,
      warn_threshold: 8,
      ban_threshold: 10,
    }),
  )
  const { rerender } = renderHook(() => useSafeguardsReset())
  await refreshSafeguards()
  rerender()
  expect(getSafeguardsSnapshot().flaggedChats).toHaveLength(1)

  useAuth.mockReturnValue({ userId: 'user-2' })
  rerender()

  expect(getSafeguardsSnapshot()).toMatchObject({
    flaggedChats: [],
    policy: null,
  })
})
