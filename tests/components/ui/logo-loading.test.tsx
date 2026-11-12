import { LOCK_FRAMES } from '@/components/onboarding/lock-frames'
import { LogoLoading } from '@/components/ui/logo-loading'
import { act, cleanup, render } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const OPEN = LOCK_FRAMES[0]
const CLOSED = LOCK_FRAMES[LOCK_FRAMES.length - 1]
const OPEN_HOLD_MS = 500
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

function lockPath(container: HTMLElement) {
  return container.querySelector('path')?.getAttribute('d')
}

function animation(container: HTMLElement) {
  return container.querySelector('svg')!.parentElement!
}

function ring(container: HTMLElement) {
  return container.querySelector('svg > circle')!
}

it('server-renders a bounded ring and open lock before styles load', () => {
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(<LogoLoading />)
  expect(lockPath(container)).toBe(OPEN)
  const [ring, lock] = container.querySelectorAll('svg')
  expect([ring.getAttribute('width'), ring.getAttribute('height')]).toEqual([
    '64',
    '64',
  ])
  expect([lock.getAttribute('width'), lock.getAttribute('height')]).toEqual([
    '32',
    '32',
  ])
})

it.each([true, false])(
  'holds open, closes, then zooms away before revealing Chat (initially loading: %s)',
  async (initiallyLoading) => {
    const onFinished = vi.fn()
    const view = render(
      <LogoLoading isLoading={initiallyLoading} onFinished={onFinished} />,
    )
    expect(lockPath(view.container)).toBe(OPEN)
    expect(ring(view.container).hasAttribute('stroke-dasharray')).toBe(
      initiallyLoading,
    )
    if (initiallyLoading) {
      await act(() => vi.advanceTimersByTimeAsync(ANIMATION_TIMEOUT_MS))
      expect(lockPath(view.container)).toBe(OPEN)
      expect(onFinished).not.toHaveBeenCalled()
      view.rerender(<LogoLoading isLoading={false} onFinished={onFinished} />)
    }

    expect(ring(view.container).hasAttribute('stroke-dasharray')).toBe(false)
    expect(ring(view.container).hasAttribute('mask')).toBe(false)

    await act(() => vi.advanceTimersByTimeAsync(OPEN_HOLD_MS - FRAME_MS))
    expect(lockPath(view.container)).toBe(OPEN)
    expect(onFinished).not.toHaveBeenCalled()
    await advanceUntil(() => lockPath(view.container) !== OPEN)
    expect(lockPath(view.container)).not.toBe(CLOSED)
    expect(animation(view.container).style.opacity).toBe('1')
    expect(onFinished).not.toHaveBeenCalled()

    await advanceUntil(
      () => Number(animation(view.container).style.opacity) < 1,
    )
    expect(lockPath(view.container)).toBe(CLOSED)
    expect(Number(animation(view.container).style.opacity)).toBeGreaterThan(0)
    expect(onFinished).not.toHaveBeenCalled()
    await advanceUntil(() => onFinished.mock.calls.length === 1)
    expect(animation(view.container).style.opacity).toBe('0')
    expect(animation(view.container).style.transform).toBe('scale(0.25)')
    await act(() => vi.advanceTimersByTimeAsync(ANIMATION_TIMEOUT_MS))
    expect(onFinished).toHaveBeenCalledTimes(1)
  },
)

it('cancels a pending reveal if loading resumes during the zoom', async () => {
  const onFinished = vi.fn()
  const view = render(<LogoLoading isLoading={false} onFinished={onFinished} />)
  await advanceUntil(() => Number(animation(view.container).style.opacity) < 1)
  expect(onFinished).not.toHaveBeenCalled()
  view.rerender(<LogoLoading isLoading onFinished={onFinished} />)
  expect(lockPath(view.container)).toBe(OPEN)
  expect(ring(view.container).hasAttribute('stroke-dasharray')).toBe(true)
  expect(ring(view.container).hasAttribute('mask')).toBe(true)
  expect(animation(view.container).style.opacity).toBe('1')
  await act(() => vi.advanceTimersByTimeAsync(ANIMATION_TIMEOUT_MS))
  expect(onFinished).not.toHaveBeenCalled()
  view.rerender(<LogoLoading isLoading={false} onFinished={onFinished} />)
  await act(() => vi.advanceTimersByTimeAsync(OPEN_HOLD_MS - FRAME_MS))
  expect(lockPath(view.container)).toBe(OPEN)
  expect(onFinished).not.toHaveBeenCalled()
  await advanceUntil(() => onFinished.mock.calls.length === 1)
})

it('does not reveal the interface after the loader unmounts', async () => {
  const onFinished = vi.fn()
  const view = render(<LogoLoading isLoading={false} onFinished={onFinished} />)
  await advanceUntil(() => lockPath(view.container) !== OPEN)
  view.unmount()
  await act(() => vi.advanceTimersByTimeAsync(ANIMATION_TIMEOUT_MS))
  expect(onFinished).not.toHaveBeenCalled()
})

it('skips the pause and motion when reduced motion is requested, while waiting for readiness', async () => {
  reducedMotion = true
  media.dispatchEvent(new Event('change'))
  const onFinished = vi.fn()
  const view = render(<LogoLoading isLoading onFinished={onFinished} />)
  await act(() => vi.advanceTimersByTimeAsync(ANIMATION_TIMEOUT_MS))
  expect(onFinished).not.toHaveBeenCalled()
  view.rerender(<LogoLoading isLoading={false} onFinished={onFinished} />)
  expect(lockPath(view.container)).toBe(CLOSED)
  await act(() => vi.advanceTimersByTimeAsync(FRAME_MS))
  expect(onFinished).toHaveBeenCalledTimes(1)
  expect(animation(view.container).style.transform).toBe('none')
})
