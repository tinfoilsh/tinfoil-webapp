import { useAutoIntelligence } from '@/components/chat/hooks/use-auto-intelligence'
import { getView, publish } from '@/services/harness/runtime'
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
it('uses the server default, then shares profile updates across mounted controls', async () => {
  const first = renderHook(() => useAutoIntelligence())
  const second = renderHook(() => useAutoIntelligence())
  expect(first.result.current.autoIntelligence).toBe('high')
  await act(async () => first.result.current.setAutoIntelligence('low'))
  expect(second.result.current.autoIntelligence).toBe('low')
  expect(getView().profile.autoIntelligence).toBe('low')
  act(() => publish({ profile: { autoIntelligence: 'max' } }))
  expect(first.result.current.autoIntelligence).toBe('max')
})
