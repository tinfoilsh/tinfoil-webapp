import { useSyncEnclaveSession } from '@/hooks/use-sync-enclave-session'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockReady = vi.fn().mockResolvedValue(undefined)
const mockFetch = vi.fn()

vi.mock('tinfoil', () => ({
  SecureClient: class {
    ready = mockReady
    fetch = mockFetch
    getVerificationDocument = () => ({})
  },
}))

vi.mock('@/services/auth', () => ({
  authTokenManager: {
    getValidToken: vi.fn().mockResolvedValue('jwt'),
  },
}))

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

const cekHex = 'aa'.repeat(32)

describe('useSyncEnclaveSession', () => {
  beforeEach(async () => {
    mockReady.mockReset().mockResolvedValue(undefined)
    mockFetch.mockReset()
    const { resetSyncEnclaveClient } = await import(
      '@/services/sync-enclave/sync-enclave-client'
    )
    resetSyncEnclaveClient()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('starts idle and stays idle while no CEK is unlocked', async () => {
    const { result } = renderHook(() => useSyncEnclaveSession(null))
    expect(result.current.status).toBe('idle')
    expect(result.current.cekHex).toBeNull()
  })

  it('becomes ready after attestation completes', async () => {
    const { result } = renderHook(() => useSyncEnclaveSession(cekHex))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.cekHex).toBe(cekHex)
    expect(mockReady).toHaveBeenCalledTimes(1)
  })

  it('moves to paused when attestation throws and keeps the cached CEK out of state', async () => {
    mockReady.mockRejectedValueOnce(new Error('attestation flake'))
    const { result } = renderHook(() => useSyncEnclaveSession(cekHex))
    await waitFor(() => expect(result.current.status).toBe('paused'))
    expect(result.current.cekHex).toBeNull()
    expect(result.current.lastError?.message).toBe('attestation flake')
  })

  it('retry() recovers from paused', async () => {
    mockReady.mockRejectedValueOnce(new Error('first attempt fails'))
    const { result } = renderHook(() => useSyncEnclaveSession(cekHex))
    await waitFor(() => expect(result.current.status).toBe('paused'))

    mockReady.mockResolvedValueOnce(undefined)
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.cekHex).toBe(cekHex)
  })

  it('clear() drops in-memory state but does not touch storage', async () => {
    const { result } = renderHook(() => useSyncEnclaveSession(cekHex))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() => result.current.clear())
    expect(result.current.status).toBe('idle')
    expect(result.current.cekHex).toBeNull()
  })

  it('reverts to idle when the unlocked CEK becomes null', async () => {
    const { result, rerender } = renderHook(
      ({ cek }: { cek: string | null }) => useSyncEnclaveSession(cek),
      { initialProps: { cek: cekHex } },
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ cek: null })
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.cekHex).toBeNull()
  })
})
