import {
  COMPACTED_NOTICE_EXIT_MS,
  COMPACTED_NOTICE_SHOWN_MS,
  CompactedNotice,
} from '@/components/chat/compaction-status'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function renderNotice() {
  const onDismiss = vi.fn()
  render(
    <CompactedNotice
      messageCount={12}
      onShow={vi.fn()}
      onDismiss={onDismiss}
    />,
  )
  return onDismiss
}

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms))
// The notice shows for its moment, then slides away.
function waitToLeave() {
  wait(COMPACTED_NOTICE_SHOWN_MS)
  wait(COMPACTED_NOTICE_EXIT_MS)
}

it('slides away once it has shown for a moment', () => {
  const onDismiss = renderNotice()

  wait(COMPACTED_NOTICE_SHOWN_MS)
  wait(COMPACTED_NOTICE_EXIT_MS - 1)
  expect(onDismiss).not.toHaveBeenCalled()
  wait(1)

  expect(onDismiss).toHaveBeenCalledOnce()
})

it('stays while the pointer or focus is on it, coming back if it was sliding away', () => {
  const onDismiss = renderNotice()
  const notice = screen.getByRole('status', { name: 'Conversation compacted' })
  const show = screen.getByRole('button', { name: 'Show summary' })
  wait(COMPACTED_NOTICE_SHOWN_MS)
  expect(notice).toHaveAttribute('data-leaving')

  fireEvent.mouseEnter(notice)
  expect(notice).not.toHaveAttribute('data-leaving')
  waitToLeave()
  waitToLeave()
  expect(notice).not.toHaveAttribute('data-leaving')
  fireEvent.mouseLeave(notice)
  act(() => show.focus())
  waitToLeave()
  waitToLeave()
  expect(onDismiss).not.toHaveBeenCalled()
  act(() => show.blur())
  waitToLeave()

  expect(onDismiss).toHaveBeenCalledOnce()
})

it('waits for the page to show again before it slides away, coming back if it was sliding away', () => {
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  const onDismiss = renderNotice()
  const notice = screen.getByRole('status', { name: 'Conversation compacted' })
  const show = (shown: boolean) => {
    hidden.mockReturnValue(!shown)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }
  waitToLeave()
  waitToLeave()
  show(true)
  wait(COMPACTED_NOTICE_SHOWN_MS)
  expect(notice).toHaveAttribute('data-leaving')

  show(false)
  expect(notice).not.toHaveAttribute('data-leaving')
  waitToLeave()
  waitToLeave()
  expect(onDismiss).not.toHaveBeenCalled()
  show(true)
  waitToLeave()

  expect(onDismiss).toHaveBeenCalledOnce()
  hidden.mockRestore()
})
