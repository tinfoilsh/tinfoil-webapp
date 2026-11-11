import { WelcomePrivacyButton } from '@/components/chat/welcome-privacy-button'
import { LOCK_FRAMES } from '@/components/onboarding/lock-frames'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const LABEL = 'Your chats are private'
const FRAME_MS = 16
const ANIMATION_TIMEOUT_MS = 5000
const media = window.matchMedia('(prefers-reduced-motion)')
const matchMedia = window.matchMedia.bind(window)
let reducedMotion = false

Object.defineProperty(media, 'matches', { get: () => reducedMotion })

beforeEach(() => {
  reducedMotion = false
  media.dispatchEvent(new Event('change'))
  vi.spyOn(window, 'matchMedia').mockImplementation((query) =>
    query.includes('prefers-reduced-motion') ? media : matchMedia(query),
  )
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
})

async function advanceUntil(predicate: () => boolean) {
  for (
    let elapsed = 0;
    elapsed < ANIMATION_TIMEOUT_MS && !predicate();
    elapsed += FRAME_MS
  ) {
    await act(() => vi.advanceTimersByTimeAsync(FRAME_MS))
  }
  expect(predicate()).toBe(true)
}

it('types the text, draws the border, then swings the open lock shut', async () => {
  render(<WelcomePrivacyButton onClick={vi.fn()} />)
  const button = screen.getByRole('button', { name: LABEL })
  const text = button.querySelector('span.absolute')!
  const border = button.querySelector('rect')!
  const borderFrame = border.parentElement!
  const lockPath = () => button.querySelector('path')?.getAttribute('d')

  expect(text.textContent).toBe('')
  expect(borderFrame).toHaveAttribute('opacity', '0')
  expect(lockPath()).toBeUndefined()

  await advanceUntil(() => !!text.textContent)
  expect(LABEL).toContain(text.textContent)
  expect(text.textContent).not.toBe(LABEL)
  expect(borderFrame).toHaveAttribute('opacity', '0')
  expect(lockPath()).toBeUndefined()

  await advanceUntil(() => borderFrame.getAttribute('opacity') === '1')
  expect(text.textContent).toBe(LABEL)
  expect(lockPath()).toBeUndefined()
  await advanceUntil(
    () => Number.parseFloat(border.getAttribute('stroke-dasharray') ?? '') > 0,
  )
  expect(
    Number.parseFloat(border.getAttribute('stroke-dasharray')!),
  ).toBeLessThan(1)
  expect(lockPath()).toBeUndefined()

  await advanceUntil(() => lockPath() !== undefined)
  expect(Number.parseFloat(border.getAttribute('stroke-dasharray')!)).toBe(1)
  expect(lockPath()).toBe(LOCK_FRAMES[0])
  await advanceUntil(() => lockPath() === LOCK_FRAMES[LOCK_FRAMES.length - 1])
})

it('shows the finished label, border, and closed lock with reduced motion', () => {
  reducedMotion = true
  media.dispatchEvent(new Event('change'))
  render(<WelcomePrivacyButton onClick={vi.fn()} />)
  const button = screen.getByRole('button', { name: LABEL })
  expect(button.querySelector('span.absolute')).toHaveTextContent(LABEL)
  const border = button.querySelector('rect')!
  expect(border.parentElement).toHaveAttribute('opacity', '1')
  expect(Number.parseFloat(border.getAttribute('stroke-dasharray')!)).toBe(1)
  expect(button.querySelector('path')).toHaveAttribute(
    'd',
    LOCK_FRAMES[LOCK_FRAMES.length - 1],
  )
})
