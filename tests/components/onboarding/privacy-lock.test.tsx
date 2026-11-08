import { LOCK_FRAMES } from '@/components/onboarding/lock-frames'
import { PrivacyLock } from '@/components/onboarding/privacy-lock'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const OPEN = LOCK_FRAMES[0]
const LOCKED = LOCK_FRAMES[LOCK_FRAMES.length - 1]

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function lockPath(container: HTMLElement) {
  return container.querySelector('path')?.getAttribute('d')
}

it('swings shut as it appears when it starts open', async () => {
  const { container } = render(<PrivacyLock locked startOpen />)
  expect(lockPath(container)).toBe(OPEN)

  await act(() => vi.advanceTimersByTimeAsync(1000))

  expect(lockPath(container)).toBe(LOCKED)
})

it('appears already shut otherwise', () => {
  const { container } = render(<PrivacyLock locked />)

  expect(lockPath(container)).toBe(LOCKED)
})
