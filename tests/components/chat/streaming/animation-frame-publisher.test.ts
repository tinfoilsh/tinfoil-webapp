import { AnimationFramePublisher } from '@/components/chat/hooks/streaming/animation-frame-publisher'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('AnimationFramePublisher', () => {
  let frames: FrameRequestCallback[]

  beforeEach(() => {
    frames = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback)
        return frames.length
      }),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('publishes queued undefined values', async () => {
    const onUpdate = vi.fn()
    const publisher = new AnimationFramePublisher<undefined>(onUpdate)

    publisher.publish(undefined)
    expect(onUpdate.mock.calls).toEqual([[undefined]])
    publisher.publish(undefined)
    expect(frames).toHaveLength(1)
    expect(onUpdate.mock.calls).toEqual([[undefined]])
    frames.shift()?.(performance.now())
    await vi.waitFor(() =>
      expect(onUpdate.mock.calls).toEqual([[undefined], [undefined]]),
    )
  })

  it('materializes only the latest queued frame value', async () => {
    const onUpdate = vi.fn()
    const staleFactory = vi.fn(() => 'stale')
    const latestFactory = vi.fn(() => 'latest')
    const publisher = new AnimationFramePublisher<string>(onUpdate)

    publisher.publish('leading')
    publisher.publishLazy(staleFactory)
    publisher.publishLazy(latestFactory)
    frames.shift()?.(performance.now())
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2))

    expect(staleFactory).not.toHaveBeenCalled()
    expect(latestFactory).toHaveBeenCalledOnce()
    expect(onUpdate).toHaveBeenLastCalledWith('latest')
  })

  it('publishes a final undefined value while hidden', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const onUpdate = vi.fn()
    const publisher = new AnimationFramePublisher<undefined>(onUpdate)

    publisher.publish(undefined)
    await publisher.finish(undefined)

    expect(onUpdate.mock.calls).toEqual([[undefined], [undefined]])
    expect(frames).toHaveLength(0)
  })

  it('drops a hidden-tab update queued before cancellation', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    let releaseLeadingUpdate!: () => void
    const onUpdate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseLeadingUpdate = resolve
        }),
    )
    const publisher = new AnimationFramePublisher(onUpdate)

    publisher.publish('leading')
    const finishing = publisher.finish('final')
    publisher.cancel()
    releaseLeadingUpdate()
    await finishing

    expect(onUpdate).toHaveBeenCalledOnce()
  })
})
