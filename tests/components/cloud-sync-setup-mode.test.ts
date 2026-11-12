import {
  classifyCloudKeySetupError,
  determineGeneratedKeySetupMode,
} from '@/components/modals/cloud-sync-setup-mode'
import { encryptionService } from '@/services/encryption/encryption-service'
import { HarnessError } from '@/services/harness/sse'
import { CloudKeySetupError } from '@/services/keys/cloud-key-preflight'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInspectRemoteEncryptedState = vi.fn()

vi.mock('@/services/keys/cloud-key-preflight', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/services/keys/cloud-key-preflight')
  >()),
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

describe('classifyCloudKeySetupError', () => {
  it('blames the key only when the key is malformed', async () => {
    const malformed: unknown = await encryptionService
      .setKey('not-a-key', { persist: false })
      .catch((error: unknown) => error)

    expect(classifyCloudKeySetupError(malformed)).toBe('invalid_key')
    // Registering a well-formed key can fail without saying anything about
    // the key, as when the harness cannot be reached.
    expect(
      classifyCloudKeySetupError(
        new HarnessError({
          code: 'CONNECTION',
          message: 'The chat service could not be reached',
          action: 'retry',
        }),
      ),
    ).toBe('setup_failed')
  })

  it.each([
    ['unknown', 'verification_unavailable'],
    ['exists', 'key_mismatch'],
  ] as const)(
    'reads a preflight refusal with remote state %s as %s',
    (remoteState, reason) => {
      expect(
        classifyCloudKeySetupError(
          new CloudKeySetupError('refused', remoteState),
        ),
      ).toBe(reason)
    },
  )
})
