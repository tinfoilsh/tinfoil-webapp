import { usePromptLibrary } from '@/components/chat/hooks/use-prompt-library'
import {
  useReasoningEffort,
  useThinkingEnabled,
} from '@/components/chat/hooks/use-reasoning-effort'
import { Toaster } from '@/components/ui/toaster'
import { useToast } from '@/hooks/use-toast'
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { client, KEY, signIn } from '../../harness-fixture'

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

// The toast module keeps its toasts across tests.
afterEach(() => {
  const { result, unmount } = renderHook(() => useToast())
  act(() => result.current.dismiss())
  unmount()
})

// Each profile update waits for the test to answer or refuse it.
function holdProfileUpdates() {
  const updates: {
    input: unknown
    answer(profile: Record<string, unknown>): void
    refuse(cause: Error): void
  }[] = []
  client.post.mockImplementation(
    (path: string, input: unknown) =>
      new Promise((answer, refuse) => {
        if (path !== '/v1/profile/update') throw new Error(`Unexpected ${path}`)
        updates.push({ input, answer, refuse })
      }),
  )
  return updates
}

it('shows a setting at once and keeps a newer change over an older answer', async () => {
  const saved = { thinkingEnabled: true, reasoningEffort: 'medium' }
  signIn({ cloud: true, profile: saved })
  const updates = holdProfileUpdates()
  const { result } = renderHook(() => useThinkingEnabled())

  act(() => result.current.setThinkingEnabled(false))
  expect(result.current.thinkingEnabled).toBe(false)
  act(() => result.current.setThinkingEnabled(true))
  expect(result.current.thinkingEnabled).toBe(true)

  await waitFor(() => expect(updates).toHaveLength(1))
  expect(updates[0].input).toEqual({
    key: KEY,
    patch: { thinkingEnabled: false },
  })
  await act(async () => updates[0].answer({ ...saved, thinkingEnabled: false }))
  expect(result.current.thinkingEnabled).toBe(true)

  await waitFor(() => expect(updates).toHaveLength(2))
  expect(updates[1].input).toEqual({
    key: KEY,
    patch: { thinkingEnabled: true },
  })
  await act(async () => updates[1].answer(saved))
  expect(result.current.thinkingEnabled).toBe(true)
})

it('takes back a setting the harness refused and says so', async () => {
  signIn({ cloud: true, profile: { reasoningEffort: 'medium' } })
  const updates = holdProfileUpdates()
  render(<Toaster />)
  const { result } = renderHook(() => useReasoningEffort())

  act(() => result.current.setReasoningEffort('high'))
  expect(result.current.reasoningEffort).toBe('high')
  expect(screen.queryByText('Failed to save settings')).not.toBeInTheDocument()

  await waitFor(() => expect(updates).toHaveLength(1))
  await act(async () =>
    updates[0].refuse(new TypeError('The connection failed')),
  )

  expect(result.current.reasoningEffort).toBe('medium')
  expect(screen.getByText('Failed to save settings')).toBeInTheDocument()
})

it('takes back a favorite prompt the harness refused and says so', async () => {
  const preset = {
    id: 'user:editor',
    name: 'Editor',
    description: '',
    systemPrompt: 'Edit text.',
    createdAt: 1,
    updatedAt: 1,
  }
  signIn({
    cloud: true,
    profile: { customPromptPresets: [preset], favoritePromptPresetIds: [] },
  })
  const updates = holdProfileUpdates()
  render(<Toaster />)
  const { result } = renderHook(() => usePromptLibrary())

  act(() => result.current.toggleFavorite(preset.id))
  expect(result.current.favoritePresetIds).toEqual([preset.id])
  expect(screen.queryByText('Failed to save settings')).not.toBeInTheDocument()

  await waitFor(() => expect(updates).toHaveLength(1))
  expect(updates[0].input).toEqual({
    key: KEY,
    patch: { favoritePromptPresetIds: [preset.id] },
  })
  await act(async () =>
    updates[0].refuse(new TypeError('The connection failed')),
  )

  expect(result.current.favoritePresetIds).toEqual([])
  expect(screen.getByText('Failed to save settings')).toBeInTheDocument()
})
