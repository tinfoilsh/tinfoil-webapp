import { determineGeneratedKeySetupMode } from '@/components/modals/cloud-sync-setup-mode'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInspectRemoteEncryptedState = vi.fn()

vi.mock('@/services/keys/cloud-key-preflight', () => ({
  inspectRemoteEncryptedState: (...args: unknown[]) =>
    mockInspectRemoteEncryptedState(...args),
}))

describe('determineGeneratedKeySetupMode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses explicitStartFresh when manual recovery is required', async () => {
    const mode = await determineGeneratedKeySetupMode({
      manualRecoveryNeeded: true,
    })

    expect(mode).toBe('explicitStartFresh')
    expect(mockInspectRemoteEncryptedState).not.toHaveBeenCalled()
  })

  it('keeps recoverExisting when the remote cloud state is empty', async () => {
    mockInspectRemoteEncryptedState.mockResolvedValue('empty')

    const mode = await determineGeneratedKeySetupMode({
      manualRecoveryNeeded: false,
    })

    expect(mode).toBe('recoverExisting')
  })

  it('uses explicitStartFresh when encrypted cloud data already exists', async () => {
    mockInspectRemoteEncryptedState.mockResolvedValue('exists')

    const mode = await determineGeneratedKeySetupMode({
      manualRecoveryNeeded: false,
    })

    expect(mode).toBe('explicitStartFresh')
  })

  it('uses explicitStartFresh when the remote cloud state is unknown', async () => {
    mockInspectRemoteEncryptedState.mockResolvedValue('unknown')

    const mode = await determineGeneratedKeySetupMode({
      manualRecoveryNeeded: false,
    })

    expect(mode).toBe('recoverExisting')
  })

  it('falls back to recoverExisting when remote inspection fails', async () => {
    mockInspectRemoteEncryptedState.mockRejectedValue(
      new Error('Network error'),
    )

    const mode = await determineGeneratedKeySetupMode({
      manualRecoveryNeeded: false,
    })

    expect(mode).toBe('recoverExisting')
  })
})
