import type { DriverConnection } from '@/services/computer-use/access-token'
import type { LoopResult } from '@/services/computer-use/loop-controller'
import { DriverError, type DriverImage } from '@/services/computer-use/types'
import { useComputerUseSession } from '@/services/computer-use/use-computer-use-session'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const fakeConn = {} as DriverConnection

const mac = (name: string): DriverImage => ({ name, os: 'mac', ready: true })
const linuxImg = (name: string): DriverImage => ({
  name,
  os: 'linux',
  ready: true,
})

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
        fetchStatusImages: async () => [mac('tahoe'), linuxImg('linux-box')],
        runLoop: vi.fn(),
      }),
    )

    await act(async () => {
      await result.current.start('research X')
    })

    expect(result.current.state.phase).toBe('consent')
    expect(result.current.state.task).toBe('research X')
    expect(result.current.state.images).toEqual([
      mac('tahoe'),
      linuxImg('linux-box'),
    ])
    expect(result.current.state.manifest?.session.image).toBe('tahoe')
    // Proposed manifest takes the OS of the chosen image, NOT a hardcoded default.
    expect(result.current.state.manifest?.session.os).toBe('mac')
  })

  it('overrides session.os from the chosen image when the model emitted a mismatched value', async () => {
    // Regression: a model picked `os:"linux"` for a macOS image. The webapp
    // must replace it with the image's actual OS — model doesn't get to disagree.
    const proposed = {
      version: 1 as const,
      session: { os: 'linux' as const, image: 'tahoe' },
    }
    const { result } = renderHook(() =>
      useComputerUseSession('kimi-k2-6', {
        getConnection: () => fakeConn,
        fetchStatusImages: async () => [mac('tahoe')],
        runLoop: vi.fn(),
      }),
    )
    await act(async () => {
      await result.current.start('go', proposed)
    })
    expect(result.current.state.manifest?.session.os).toBe('mac')
    expect(result.current.state.manifest?.session.image).toBe('tahoe')
  })

  it('approve also re-applies image OS to defeat a mid-edit OS field', async () => {
    const runLoop = vi.fn(async () => loopResult())
    const { result } = renderHook(() =>
      useComputerUseSession('kimi-k2-6', {
        getConnection: () => fakeConn,
        fetchStatusImages: async () => [mac('tahoe')],
        runLoop,
      }),
    )
    await act(async () => {
      await result.current.start('go')
    })
    // Caller (or a buggy editor) supplies an explicit wrong OS.
    const tampered = {
      version: 1 as const,
      session: { os: 'linux' as const, image: 'tahoe' },
    }
    await act(async () => {
      await result.current.approve(tampered)
    })
    expect(runLoop.mock.calls[0][0].manifest.session.os).toBe('mac')
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
        fetchStatusImages: async () => [mac('tahoe')],
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

  it('re-pairs when a stored credential is rejected (driver restarted → /token 401)', async () => {
    const staleConn = {
      tokens: {
        getAccessToken: async () => {
          throw new DriverError('invalid refresh credential', 401)
        },
      },
    } as unknown as DriverConnection
    const pair = vi.fn(async () => fakeConn)
    const { result } = renderHook(() =>
      useComputerUseSession('kimi-k2-6', {
        getConnection: () => staleConn,
        pair,
        fetchStatusImages: async () => [mac('tahoe')],
        runLoop: vi.fn(),
      }),
    )

    await act(async () => {
      await result.current.start('do it')
    })

    expect(pair).toHaveBeenCalledOnce() // dropped the stale credential, re-paired
    expect(result.current.state.phase).toBe('consent')
  })

  it('does NOT re-pair when the driver is merely unreachable (not an auth error)', async () => {
    const downConn = {
      tokens: {
        getAccessToken: async () => {
          throw new DriverError('driver unreachable', 0, true)
        },
      },
    } as unknown as DriverConnection
    const pair = vi.fn(async () => fakeConn)
    const { result } = renderHook(() =>
      useComputerUseSession('kimi-k2-6', {
        getConnection: () => downConn,
        pair,
        fetchStatusImages: async () => [mac('tahoe')],
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
        fetchStatusImages: async () => [mac('tahoe')],
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
        fetchStatusImages: async () => [mac('tahoe')],
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
          throw new Error('driver exploded')
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

  it('capability escalation: pause → approve → driver.escalate is called + manifest egress updates', async () => {
    // The loop, on detecting `request_capability`, awaits the hook's
    // `requestCapabilityApproval` injection. Once we click Approve, the
    // promise resolves and the loop continues; on a successful approval
    // we also expect the displayed manifest's `network.egress` to reflect
    // the new list (so the config widget shows current state).
    let runLoopPromiseResolve: (value: any) => void = () => {}
    const escalateCalls: Array<{ session: string; egress: string[] }> = []
    const runLoop = vi.fn(async (p: any) => {
      // Simulate the loop emitting begin, then asking for capability.
      p.onEvent({ type: 'begin', session: 's', screenshot: { content: [] } })
      const approval = await p.requestCapabilityApproval({
        egress: ['www.reddit.com'],
      })
      if (approval.approved) {
        const { egress } = await p.driver.escalate('sess_abc', approval.egress)
        escalateCalls.push({ session: 'sess_abc', egress })
        p.onEvent({
          type: 'capability_result',
          callId: 'c1',
          approved: true,
          egress,
        })
      }
      p.onEvent({
        type: 'stopped',
        reason: 'model_finished',
        finalText: 'done',
      })
      return runLoopPromiseResolve({
        session: 's',
        reason: 'model_finished',
        finalText: 'done',
        steps: 1,
        ended: true,
      })
    })
    const conn = {
      client: {
        escalate: async (s: string, egress: string[]) => ({ egress }),
      },
    } as unknown as DriverConnection
    const { result } = renderHook(() =>
      useComputerUseSession('kimi-k2-6', {
        getConnection: () => conn,
        fetchStatusImages: async () => [mac('tahoe')],
        runLoop: runLoop as any,
      }),
    )
    await act(async () => {
      await result.current.start('go')
    })
    // Kick off approve in a separate act block so the loop can spin up.
    let approvePromise: Promise<any> | undefined
    await act(async () => {
      approvePromise = result.current.approve(result.current.state.manifest!)
      // Yield so the loop runs to the requestCapabilityApproval await.
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(result.current.state.capabilityRequest?.egress).toEqual([
      'www.reddit.com',
    ])
    // User approves with an edit (added '*.redditstatic.com').
    await act(async () => {
      result.current.approveCapability(['www.reddit.com', '*.redditstatic.com'])
      // Let the loop continue to finish.
      await new Promise((r) => setTimeout(r, 10))
      await approvePromise
    })
    expect(escalateCalls).toHaveLength(1)
    expect(escalateCalls[0].egress).toEqual([
      'www.reddit.com',
      '*.redditstatic.com',
    ])
    expect(result.current.state.manifest?.network?.egress).toEqual([
      'www.reddit.com',
      '*.redditstatic.com',
    ])
    expect(result.current.state.capabilityRequest).toBeUndefined()
  })

  it('capability escalation: deny resolves the promise without calling escalate', async () => {
    let denied = false
    const runLoop = vi.fn(async (p: any) => {
      const approval = await p.requestCapabilityApproval({
        egress: ['evil.com'],
      })
      denied = !approval.approved
      return {
        session: 's',
        reason: 'model_finished',
        finalText: '',
        steps: 0,
        ended: true,
      }
    })
    const escalate = vi.fn()
    const conn = { client: { escalate } } as unknown as DriverConnection
    const { result } = renderHook(() =>
      useComputerUseSession('kimi-k2-6', {
        getConnection: () => conn,
        fetchStatusImages: async () => [mac('tahoe')],
        runLoop: runLoop as any,
      }),
    )
    await act(async () => {
      await result.current.start('go')
    })
    let approvePromise: Promise<any> | undefined
    await act(async () => {
      approvePromise = result.current.approve(result.current.state.manifest!)
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(result.current.state.capabilityRequest?.egress).toEqual(['evil.com'])
    await act(async () => {
      result.current.denyCapability('test deny')
      await new Promise((r) => setTimeout(r, 10))
      await approvePromise
    })
    expect(denied).toBe(true)
    expect(escalate).not.toHaveBeenCalled()
    expect(result.current.state.capabilityRequest).toBeUndefined()
  })

  it('cancel resets to idle', async () => {
    const { result } = renderHook(() =>
      useComputerUseSession('kimi-k2-6', {
        getConnection: () => fakeConn,
        fetchStatusImages: async () => [mac('tahoe')],
        runLoop: vi.fn(),
      }),
    )
    await act(async () => {
      await result.current.start('go')
    })
    act(() => result.current.cancel())
    expect(result.current.state.phase).toBe('idle')
  })

  describe('connect (eager pairing)', () => {
    it('paired already (valid stored credential): returns true without re-pairing', async () => {
      const tokenConn = {
        tokens: { getAccessToken: async () => 'jwt' },
      } as unknown as DriverConnection
      const pair = vi.fn(async () => fakeConn)
      const { result } = renderHook(() =>
        useComputerUseSession('kimi-k2-6', {
          getConnection: () => tokenConn,
          pair,
          fetchStatusImages: async () => [mac('tahoe')],
          runLoop: vi.fn(),
        }),
      )

      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.connect()
      })
      expect(ok).toBe(true)
      expect(pair).not.toHaveBeenCalled()
      expect(result.current.state.phase).toBe('idle')
    })

    it('not paired: surfaces the code via pairingCode and resolves to true on success', async () => {
      const pair = vi.fn(async (opts: any) => {
        opts.onCode('XK19')
        return fakeConn
      })
      const { result } = renderHook(() =>
        useComputerUseSession('kimi-k2-6', {
          getConnection: () => null,
          pair,
          fetchStatusImages: async () => [mac('tahoe')],
          runLoop: vi.fn(),
        }),
      )

      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.connect()
      })
      expect(ok).toBe(true)
      expect(pair).toHaveBeenCalledOnce()
      expect(result.current.state.phase).toBe('idle')
    })

    it('stale credential (401): re-pairs and succeeds', async () => {
      const staleConn = {
        tokens: {
          getAccessToken: async () => {
            throw new DriverError('invalid refresh credential', 401)
          },
        },
      } as unknown as DriverConnection
      const pair = vi.fn(async () => fakeConn)
      const { result } = renderHook(() =>
        useComputerUseSession('kimi-k2-6', {
          getConnection: () => staleConn,
          pair,
          fetchStatusImages: async () => [mac('tahoe')],
          runLoop: vi.fn(),
        }),
      )
      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.connect()
      })
      expect(pair).toHaveBeenCalledOnce()
      expect(ok).toBe(true)
    })

    it('pairing fails: returns false and surfaces the error', async () => {
      const pair = vi.fn(async () => {
        throw new Error('pairing denied')
      })
      const { result } = renderHook(() =>
        useComputerUseSession('kimi-k2-6', {
          getConnection: () => null,
          pair,
          fetchStatusImages: async () => [mac('tahoe')],
          runLoop: vi.fn(),
        }),
      )
      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.connect()
      })
      expect(ok).toBe(false)
      expect(result.current.state.phase).toBe('error')
      expect(result.current.state.error).toMatch(/denied/)
    })

    it('does not invoke runLoop (distinct from start)', async () => {
      const runLoop = vi.fn()
      const { result } = renderHook(() =>
        useComputerUseSession('kimi-k2-6', {
          getConnection: () => null,
          pair: async () => fakeConn,
          fetchStatusImages: async () => [mac('tahoe')],
          runLoop,
        }),
      )
      await act(async () => {
        await result.current.connect()
      })
      expect(runLoop).not.toHaveBeenCalled()
    })
  })
})
