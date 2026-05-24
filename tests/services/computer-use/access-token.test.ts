import { AccessTokenManager } from '@/services/computer-use/access-token'
import { DriverError, type TokenResponse } from '@/services/computer-use/types'
import { describe, expect, it, vi } from 'vitest'

function tokenResponse(
  token: string,
  expiresInSec: number,
  nowMs: number,
): TokenResponse {
  return {
    access_token: token,
    expires_at: Math.floor(nowMs / 1000) + expiresInSec,
    expires_in: expiresInSec,
  }
}

describe('AccessTokenManager', () => {
  it('mints once and caches while valid', async () => {
    let now = 1_000_000
    const mint = vi.fn(async () => tokenResponse('t1', 300, now))
    const mgr = new AccessTokenManager(mint, 'refresh', () => now)

    expect(await mgr.getAccessToken()).toBe('t1')
    now += 60_000 // 1 min later, still well within the 5-min token
    expect(await mgr.getAccessToken()).toBe('t1')
    expect(mint).toHaveBeenCalledOnce()
  })

  it('re-mints proactively within the skew window of expiry', async () => {
    let now = 1_000_000
    let n = 0
    const mint = vi.fn(async () => tokenResponse(`t${++n}`, 300, now))
    const mgr = new AccessTokenManager(mint, 'refresh', () => now)

    expect(await mgr.getAccessToken()).toBe('t1')
    // Jump to within the 30s skew of the 300s token's expiry.
    now += 280_000
    expect(await mgr.getAccessToken()).toBe('t2')
    expect(mint).toHaveBeenCalledTimes(2)
  })

  it('dedupes concurrent mints into one in-flight request', async () => {
    let now = 1_000_000
    const mint = vi.fn(
      () =>
        new Promise<TokenResponse>((resolve) =>
          setTimeout(() => resolve(tokenResponse('t1', 300, now)), 5),
        ),
    )
    const mgr = new AccessTokenManager(mint, 'refresh', () => now)

    const [a, b] = await Promise.all([
      mgr.getAccessToken(),
      mgr.getAccessToken(),
    ])
    expect(a).toBe('t1')
    expect(b).toBe('t1')
    expect(mint).toHaveBeenCalledOnce()
  })

  it('invalidate forces a re-mint on the next call', async () => {
    let now = 1_000_000
    let n = 0
    const mint = vi.fn(async () => tokenResponse(`t${++n}`, 300, now))
    const mgr = new AccessTokenManager(mint, 'refresh', () => now)

    expect(await mgr.getAccessToken()).toBe('t1')
    mgr.invalidate()
    expect(await mgr.getAccessToken()).toBe('t2')
    expect(mint).toHaveBeenCalledTimes(2)
  })

  it('propagates an auth error and clears cached state (revoked refresh credential)', async () => {
    const now = 1_000_000
    const mint = vi.fn(async () => {
      throw new DriverError('invalid refresh credential', 401)
    })
    const mgr = new AccessTokenManager(mint, 'refresh', () => now)

    await expect(mgr.getAccessToken()).rejects.toMatchObject({ status: 401 })
    // A subsequent call retries minting (not stuck on a cached failure).
    await expect(mgr.getAccessToken()).rejects.toBeInstanceOf(DriverError)
    expect(mint).toHaveBeenCalledTimes(2)
  })

  it('invokes onRefreshRejected when the credential is rejected (so it can be rotated)', async () => {
    const now = 1_000_000
    const onRefreshRejected = vi.fn()
    const mint = vi.fn(async () => {
      throw new DriverError('invalid refresh credential', 401)
    })
    const mgr = new AccessTokenManager(
      mint,
      'refresh',
      () => now,
      onRefreshRejected,
    )

    await expect(mgr.getAccessToken()).rejects.toBeInstanceOf(DriverError)
    expect(onRefreshRejected).toHaveBeenCalledOnce()
  })

  it('does NOT invoke onRefreshRejected on a non-auth error', async () => {
    const now = 1_000_000
    const onRefreshRejected = vi.fn()
    const mint = vi.fn(async () => {
      throw new DriverError('driver unreachable', 0, true)
    })
    const mgr = new AccessTokenManager(
      mint,
      'refresh',
      () => now,
      onRefreshRejected,
    )

    await expect(mgr.getAccessToken()).rejects.toBeInstanceOf(DriverError)
    expect(onRefreshRejected).not.toHaveBeenCalled()
  })
})
