import { determineGeneratedKeySetupMode } from '@/components/modals/cloud-sync-setup-mode'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInspectRemoteEncryptedState = vi.fn()

vi.mock('@/services/cloud/cloud-key-preflight', () => ({
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

  it.each(['unknown', 'rejected'] as const)(
    'keeps recoverExisting when inspection is %s',
    async (result) => {
      if (result === 'unknown') {
        mockInspectRemoteEncryptedState.mockResolvedValue('unknown')
      } else {
        mockInspectRemoteEncryptedState.mockRejectedValue(
          new Error('Network error'),
        )
      }

      const mode = await determineGeneratedKeySetupMode({
        manualRecoveryNeeded: false,
      })

      expect(mode).toBe('recoverExisting')
      expect(mockInspectRemoteEncryptedState).toHaveBeenCalledTimes(1)
    },
  )
})
