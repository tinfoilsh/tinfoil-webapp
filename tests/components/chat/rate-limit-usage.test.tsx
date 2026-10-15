import {
  formatResetCountdown,
  formatTokenCount,
  RateLimitUsage,
} from '@/components/chat/rate-limit-usage'
import type { HarnessClient } from '@/services/harness/client'
import {
  activateAPI,
  getView,
  HarnessAPI,
  harnessAPI,
  publish,
} from '@/services/harness/runtime'
import type { Frame, RateLimit } from '@/services/harness/types'
import { useThread } from '@/services/harness/use-thread'
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testSession } from '../../harness-fixture'

vi.mock('@/components/chat/genui/registry', () => ({ GENUI_WIDGETS: [] }))
vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

const NOW = new Date('2026-07-24T10:15:30Z')

const hourly = (
  used: number,
  resetsAt = '2026-07-24T11:00:00Z',
): RateLimit => ({
  kind: 'hourly',
  resetsAt,
  inputTokens: { max: 2_000_000, used, remaining: 2_000_000 - used },
  outputTokens: { max: 100_000, used: 1_000, remaining: 99_000 },
})

async function refreshSession(rateLimit: RateLimit) {
  vi.mocked(harnessAPI().client.post).mockImplementation(async (path) =>
    path === '/v1/session'
      ? { ...structuredClone(testSession), rateLimit }
      : {},
  )
  await act(async () => {
    await harnessAPI().refresh()
  })
}

describe('formatResetCountdown', () => {
  const now = NOW.getTime()

  it('shows only minutes under an hour and rounds up partial minutes', () => {
    expect(formatResetCountdown('2026-07-24T10:27:00Z', now)).toBe('12m')
  })

  it('shows hours and minutes past an hour', () => {
    expect(formatResetCountdown('2026-07-24T14:27:00Z', now)).toBe('4h 12m')
  })

  it('omits the minute part on an exact hour boundary', () => {
    expect(formatResetCountdown('2026-07-24T12:15:30Z', now)).toBe('2h')
  })

  it('returns null for past, empty, or invalid timestamps', () => {
    expect(formatResetCountdown('2026-07-24T10:15:30Z', now)).toBeNull()
    expect(formatResetCountdown('2026-07-24T09:00:00Z', now)).toBeNull()
    expect(formatResetCountdown('', now)).toBeNull()
    expect(formatResetCountdown('not-a-date', now)).toBeNull()
  })
})

describe('formatTokenCount', () => {
  it('clamps negative counts and preserves compact rounding', () => {
    expect(formatTokenCount(-1)).toBe('0')
    expect(formatTokenCount(750_000)).toBe('750K')
    expect(formatTokenCount(2_000_000)).toBe('2M')
    expect(formatTokenCount(1_250_000)).toBe('1.3M')
    expect(formatTokenCount(0)).toBe('0')
  })
})

describe('RateLimitUsage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders nothing until token budgets are known', async () => {
    const { container } = render(<RateLimitUsage isPremium />)
    expect(container).toBeEmptyDOMElement()

    await refreshSession({ kind: 'free_daily', maxRequests: 7, remaining: 5 })
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the session's input and output budgets with a reset countdown", async () => {
    render(<RateLimitUsage isPremium />)

    await refreshSession({
      kind: 'free_daily',
      maxRequests: 7,
      remaining: 5,
      resetsAt: '2026-07-25T00:00:00Z',
      inputTokens: { max: 2_000_000, used: 500_000, remaining: 1_500_000 },
      outputTokens: { max: 100_000, used: 90_000, remaining: 10_000 },
    })

    expect(screen.getByText('Daily usage')).toBeInTheDocument()
    expect(screen.getByText('Resets in 13h 45m')).toBeInTheDocument()
    expect(screen.getByText('500K / 2M')).toBeInTheDocument()
    expect(screen.getByText('90K / 100K')).toBeInTheDocument()
    expect(
      screen.getByRole('progressbar', { name: 'Input token usage' }),
    ).toHaveAttribute('aria-valuenow', '25')
    expect(
      screen.getByRole('progressbar', { name: 'Output token usage' }),
    ).toHaveAttribute('aria-valuenow', '90')
  })

  it('advances the countdown as time passes', async () => {
    render(<RateLimitUsage isPremium />)
    await refreshSession(hourly(10, '2026-07-24T10:20:00Z'))
    expect(screen.getByText('Resets in 5m')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31 * 1000)
    })
    expect(screen.getByText('Resets in 4m')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
    })
    expect(screen.queryByText(/Resets in/)).not.toBeInTheDocument()
  })

  it('hides known budgets without a confirmed subscription and after it ends', async () => {
    const { container, rerender } = render(<RateLimitUsage isPremium={false} />)
    await refreshSession(hourly(0))
    expect(container).toBeEmptyDOMElement()

    rerender(<RateLimitUsage isPremium />)
    expect(screen.getByText('Hourly usage')).toBeInTheDocument()
    expect(screen.getByText('0 / 2M')).toBeInTheDocument()

    rerender(<RateLimitUsage isPremium={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('flags an exhausted dimension of a capped subscriber', async () => {
    render(<RateLimitUsage isPremium />)
    await refreshSession({
      kind: 'hourly',
      maxRequests: 0,
      remaining: 0,
      resetsAt: '2026-07-24T11:00:00Z',
      inputTokens: { max: 20_000_000, used: 3_000_000, remaining: 17_000_000 },
      outputTokens: { max: 1_000_000, used: 1_000_000, remaining: 0 },
    })

    expect(screen.getByText('Hourly usage')).toBeInTheDocument()
    expect(screen.getByText('Resets in 45m')).toBeInTheDocument()
    expect(screen.getByText('1M / 1M')).toHaveClass('text-destructive')
    expect(
      screen.getByRole('progressbar', { name: 'Output token usage' }),
    ).toHaveAttribute('aria-valuenow', '100')
  })
})

describe('usage reported by runs', () => {
  let events: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sessionStorage.clear()
    events = vi.fn()
    activateAPI(
      new HarnessAPI(
        {
          events,
          // A finished run refreshes the session.
          post: vi
            .fn()
            .mockImplementation(async (path: string) =>
              path === '/v1/session' ? structuredClone(testSession) : {},
            ),
        } as unknown as HarnessClient,
        null,
      ),
    )
    publish({ session: testSession, keyReady: true, profileReady: true })
  })

  afterEach(cleanup)

  function run(
    runId: string,
    snapshot: RateLimit,
    spend?: { prompt_tokens: number; completion_tokens: number },
  ) {
    return async function* (): AsyncGenerator<Frame> {
      const frames: Frame['event'][] = [
        { type: 'RUN_STARTED', threadId: 'thread-1', runId },
        {
          type: 'STATE_SNAPSHOT',
          snapshot: { thread: null, queue: [], rateLimit: snapshot },
        },
        {
          type: 'RUN_FINISHED',
          threadId: 'thread-1',
          runId,
          metadata: {
            rateLimit: snapshot as never,
            ...(spend ? { usage: { ...spend, total_tokens: 0 } } : {}),
          },
        },
      ]
      for (const [id, event] of frames.entries()) yield { id, event }
    }
  }

  it("counts a finished run's spend until a later report includes it", async () => {
    render(<RateLimitUsage isPremium />)
    const { result } = renderHook(() => useThread())

    events.mockImplementationOnce(
      run('run-1', hourly(500_000), {
        prompt_tokens: 100_000,
        completion_tokens: 2_000,
      }),
    )
    await act(() => result.current.send({ content: 'first' }))
    expect(getView().rateLimit).toEqual({
      kind: 'hourly',
      resetsAt: '2026-07-24T11:00:00Z',
      inputTokens: { max: 2_000_000, used: 600_000, remaining: 1_400_000 },
      outputTokens: { max: 100_000, used: 3_000, remaining: 97_000 },
    })
    expect(screen.getByText('600K / 2M')).toBeInTheDocument()

    // The next run reports the same stale exchange; usage does not move back.
    events.mockImplementationOnce(run('run-2', hourly(500_000)))
    await act(() => result.current.send({ content: 'second' }))
    expect(screen.getByText('600K / 2M')).toBeInTheDocument()

    // A fresh exchange that counted more takes over.
    events.mockImplementationOnce(run('run-3', hourly(700_000)))
    await act(() => result.current.send({ content: 'third' }))
    expect(screen.getByText('700K / 2M')).toBeInTheDocument()

    // A new window starts from its own report.
    events.mockImplementationOnce(
      run('run-4', hourly(5_000, '2026-07-24T12:00:00Z')),
    )
    await act(() => result.current.send({ content: 'fourth' }))
    expect(screen.getByText('5K / 2M')).toBeInTheDocument()
    expect(result.current.error).toBe('')
    expect(getView().error).toBeUndefined()
  })

  it('does not count a replayed final event twice', async () => {
    const { result } = renderHook(() => useThread())
    const spend = { prompt_tokens: 1_000, completion_tokens: 10 }
    events.mockImplementationOnce(async function* () {
      yield* run('run-1', hourly(0), spend)()
      // The same final event again, as a reconnect replays it.
      yield {
        id: 2,
        event: {
          type: 'RUN_FINISHED',
          threadId: 'thread-1',
          runId: 'run-1',
          metadata: { usage: { ...spend, total_tokens: 0 } },
        },
      }
    })

    await act(() => result.current.send({ content: 'once' }))

    expect(getView().rateLimit?.inputTokens).toEqual({
      max: 2_000_000,
      used: 1_000,
      remaining: 1_999_000,
    })
  })
})
