import type { BrokerConnection } from '@/services/computer-use/access-token'
import type { LoopResult } from '@/services/computer-use/loop-controller'
import { BrokerError } from '@/services/computer-use/types'
import { useComputerUseSession } from '@/services/computer-use/use-computer-use-session'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const fakeConn = {} as BrokerConnection

function loopResult(over: Partial<LoopResult> = {}): LoopResult {
  return {
    session: 's',
    reason: 'model_finished',
    finalText: 'done',
    steps: 1,
    ended: true,
    ...over,
  }
}

describe('useComputerUseSession', () => {
  it('already paired: start → consent with images + a proposed manifest', async () => {
    const { result } = renderHook(() =>
      useComputerUseSession('kimi-k2-6', {
        getConnection: () => fakeConn,
        fetchStatusImages: async () => ['tahoe', 'linux-box'],
        runLoop: vi.fn(),
      }),
    )

    await act(async () => {
      await result.current.start('research X')
    })

    expect(result.current.state.phase).toBe('consent')
    expect(result.current.state.task).toBe('research X')
    expect(result.current.state.images).toEqual(['tahoe', 'linux-box'])
    expect(result.current.state.manifest?.session.image).toBe('tahoe')
  })

  it('not paired: runs pairing (surfacing the code) before consent', async () => {
    const pair = vi.fn(async (opts: any) => {
      opts.onCode('AB23')
      opts.onState('approved')
      return fakeConn
    })
    const { result } = renderHook(() =>
      useComputerUseSession('kimi-k2-6', {
        getConnection: () => null,
        pair,
        fetchStatusImages: async () => ['tahoe'],
        runLoop: vi.fn(),
      }),
    )

    await act(async () => {
      await result.current.start('do it')
    })

    expect(pair).toHaveBeenCalledOnce()
    expect(result.current.state.pairingCode).toBe('AB23')
    expect(result.current.state.phase).toBe('consent')
  })

  it('re-pairs when a stored credential is rejected (broker restarted → /token 401)', async () => {
    const staleConn = {
      tokens: {
        getAccessToken: async () => {
          throw new BrokerError('invalid refresh credential', 401)
        },
      },
    } as unknown as BrokerConnection
    const pair = vi.fn(async () => fakeConn)
    const { result } = renderHook(() =>
      useComputerUseSession('kimi-k2-6', {
        getConnection: () => staleConn,
        pair,
        fetchStatusImages: async () => ['tahoe'],
        runLoop: vi.fn(),
      }),
    )

    await act(async () => {
      await result.current.start('do it')
    })

    expect(pair).toHaveBeenCalledOnce() // dropped the stale credential, re-paired
    expect(result.current.state.phase).toBe('consent')
  })

  it('does NOT re-pair when the broker is merely unreachable (not an auth error)', async () => {
    const downConn = {
      tokens: {
        getAccessToken: async () => {
          throw new BrokerError('broker unreachable', 0, true)
        },
      },
    } as unknown as BrokerConnection
    const pair = vi.fn(async () => fakeConn)
    const { result } = renderHook(() =>
      useComputerUseSession('kimi-k2-6', {
        getConnection: () => downConn,
        pair,
        fetchStatusImages: async () => ['tahoe'],
        runLoop: vi.fn(),
      }),
    )

    await act(async () => {
      await result.current.start('do it')
    })

    expect(pair).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.state.phase).toBe('error'))
  })

  it('approve → runs the loop, streams frames, ends done', async () => {
    const runLoop = vi.fn(async (p: any) => {
      p.onEvent({ type: 'begin', session: 's', screenshot: { content: [] } })
      p.onEvent({
        type: 'stopped',
        reason: 'model_finished',
        finalText: 'all set',
      })
      return loopResult({ finalText: 'all set' })
    })
    const { result } = renderHook(() =>
      useComputerUseSession('kimi-k2-6', {
        getConnection: () => fakeConn,
        fetchStatusImages: async () => ['tahoe'],
        runLoop,
      }),
    )

    await act(async () => {
      await result.current.start('go')
    })
    await act(async () => {
      await result.current.approve(result.current.state.manifest!)
    })

    expect(runLoop).toHaveBeenCalledOnce()
    expect(runLoop.mock.calls[0][0].manifest.session.image).toBe('tahoe')
    expect(result.current.state.phase).toBe('done')
    expect(result.current.state.finalText).toBe('all set')
    expect(result.current.state.frames).toHaveLength(2)
  })

  it('handoff result lands in the handoff phase', async () => {
    const { result } = renderHook(() =>
      useComputerUseSession('kimi-k2-6', {
        getConnection: () => fakeConn,
        fetchStatusImages: async () => ['tahoe'],
        runLoop: vi.fn(async () =>
          loopResult({ reason: 'handoff', ended: false }),
        ),
      }),
    )
    await act(async () => {
      await result.current.start('go')
    })
    await act(async () => {
      await result.current.approve(result.current.state.manifest!)
    })
    expect(result.current.state.phase).toBe('handoff')
  })

  it('surfaces a connection error', async () => {
    const { result } = renderHook(() =>
      useComputerUseSession('kimi-k2-6', {
        getConnection: () => {
          throw new Error('broker exploded')
        },
        runLoop: vi.fn(),
      }),
    )
    await act(async () => {
      await result.current.start('go')
    })
    await waitFor(() => expect(result.current.state.phase).toBe('error'))
    expect(result.current.state.error).toMatch(/exploded/)
  })

  it('cancel resets to idle', async () => {
    const { result } = renderHook(() =>
      useComputerUseSession('kimi-k2-6', {
        getConnection: () => fakeConn,
        fetchStatusImages: async () => ['tahoe'],
        runLoop: vi.fn(),
      }),
    )
    await act(async () => {
      await result.current.start('go')
    })
    act(() => result.current.cancel())
    expect(result.current.state.phase).toBe('idle')
  })
})
