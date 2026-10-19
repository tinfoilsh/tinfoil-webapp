import {
  acquireRecoverableTinfoilTransport,
  resetTinfoilClient,
} from '@/services/inference/tinfoil-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => {
  const ready = vi.fn(async () => undefined)
  const instances: unknown[] = []

  class SecureClient {
    fetch = vi.fn()

    constructor() {
      instances.push(this)
    }

    ready() {
      return ready()
    }
  }

  return { instances, ready, SecureClient }
})

vi.mock('@/config', () => ({
  API_BASE_URL: 'https://api.example',
  DEV_API_KEY: '',
  IS_DEV: false,
}))

vi.mock('openai', () => ({
  default: class OpenAI {},
}))

vi.mock('tinfoil', () => ({
  AuthenticationError: class AuthenticationError extends Error {},
  SecureClient: sdk.SecureClient,
}))

describe('recoverable transport pool', () => {
  beforeEach(() => {
    resetTinfoilClient()
    sdk.instances.length = 0
    sdk.ready.mockClear()
  })

  it('reuses a released attested transport', async () => {
    const first = await acquireRecoverableTinfoilTransport()
    first.release()
    const second = await acquireRecoverableTinfoilTransport()

    expect(second.transport).toBe(first.transport)
    expect(sdk.instances).toHaveLength(1)
    expect(sdk.ready).toHaveBeenCalledTimes(1)
    second.release()
  })

  it('keeps concurrent leases on separate transports', async () => {
    const first = await acquireRecoverableTinfoilTransport()
    const second = await acquireRecoverableTinfoilTransport()

    expect(second.transport).not.toBe(first.transport)
    expect(sdk.instances).toHaveLength(2)
    first.release()
    second.release()
  })
})
