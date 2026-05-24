import { DriverStatusPoller } from '@/services/computer-use/status-poller'
import { DriverError, type DriverStatus } from '@/services/computer-use/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STATUS: DriverStatus = {
  installed: true,
  running: true,
  version: '0.1',
  images: [{ name: 'a', os: 'mac', ready: true }],
}

function makePoller(
  getStatus: (signal?: AbortSignal) => Promise<DriverStatus>,
) {
  const poller = new DriverStatusPoller({
    getStatus,
    onUpdate: () => {},
    connectedIntervalMs: 20_000,
    disconnectedIntervalMs: 2_000,
  })
  return poller
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('DriverStatusPoller', () => {
  it('probes immediately on start and reports connected/ready', async () => {
    const getStatus = vi.fn().mockResolvedValue(STATUS)
    const poller = makePoller(getStatus)
    poller.start()
    await vi.advanceTimersByTimeAsync(1)

    expect(getStatus).toHaveBeenCalledOnce()
    expect(poller.getState()).toMatchObject({
      indicator: 'connected',
      readiness: 'ready',
    })
    poller.stop()
  })

  it('uses the slow heartbeat once connected', async () => {
    const getStatus = vi.fn().mockResolvedValue(STATUS)
    const poller = makePoller(getStatus)
    poller.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(getStatus).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000) // well within 20s
    expect(getStatus).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(20_000) // crosses the heartbeat
    expect(getStatus).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('polls fast while disconnected', async () => {
    const getStatus = vi
      .fn()
      .mockRejectedValue(new DriverError('unreachable', 0, true))
    const poller = makePoller(getStatus)
    poller.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(poller.getState().indicator).toBe('disconnected')
    expect(getStatus).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000) // within the 2s fast cadence
    expect(getStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(getStatus).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('backs off exponentially while disconnected', async () => {
    const getStatus = vi
      .fn()
      .mockRejectedValue(new DriverError('unreachable', 0, true))
    const poller = makePoller(getStatus)
    poller.start()

    await vi.advanceTimersByTimeAsync(1) // probe 1; next at base (2s)
    expect(getStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_000) // probe 2; next backs off to 4s
    expect(getStatus).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(2_000) // only 2s — within the 4s backoff
    expect(getStatus).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2_000) // crosses 4s → probe 3
    expect(getStatus).toHaveBeenCalledTimes(3)
    poller.stop()
  })

  it('flips to disconnected when a heartbeat probe starts failing (daemon died)', async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(STATUS)
      .mockRejectedValue(new DriverError('unreachable', 0, true))
    const poller = makePoller(getStatus)
    poller.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(poller.getState().indicator).toBe('connected')

    await vi.advanceTimersByTimeAsync(20_000)
    expect(poller.getState().indicator).toBe('disconnected')
    poller.stop()
  })

  it('refresh() probes immediately and cancels the pending timer', async () => {
    const getStatus = vi.fn().mockResolvedValue(STATUS)
    const poller = makePoller(getStatus)
    poller.start()
    await vi.advanceTimersByTimeAsync(1)
    expect(getStatus).toHaveBeenCalledTimes(1)

    await poller.refresh()
    expect(getStatus).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('stop() halts all further probing', async () => {
    const getStatus = vi.fn().mockResolvedValue(STATUS)
    const poller = makePoller(getStatus)
    poller.start()
    await vi.advanceTimersByTimeAsync(1)
    poller.stop()

    await vi.advanceTimersByTimeAsync(100_000)
    expect(getStatus).toHaveBeenCalledTimes(1)
  })
})
