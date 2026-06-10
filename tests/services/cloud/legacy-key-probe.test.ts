import {
  legacyKeyProbeAllowsBinding,
  probeLegacyDataWithLocalKeys,
} from '@/services/cloud/legacy-key-probe'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockPull = vi.fn()
const mockMigrationKeys = vi.fn()

vi.mock('@/utils/error-handling', () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
}))

vi.mock('@/services/sync-enclave/sync-api', () => ({
  pull: (...args: unknown[]) => mockPull(...args),
}))

vi.mock('@/services/cloud/cek-encoding', () => ({
  migrationKeys: (...args: unknown[]) => mockMigrationKeys(...args),
}))

describe('legacy-key-probe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMigrationKeys.mockReturnValue([{ key: 'cek-b64' }])
    mockPull.mockResolvedValue({ items: [] })
  })

  it('samples chats, profile, projects, and project documents', async () => {
    await probeLegacyDataWithLocalKeys()

    expect(mockPull).toHaveBeenCalledTimes(4)
    expect(mockPull.mock.calls.map(([arg]) => arg.scope)).toEqual([
      'chat',
      'profile',
      'project',
      'project_document',
    ])
  })

  it('allows binding when sampled rows decrypt', async () => {
    mockPull.mockResolvedValue({ items: [{ id: 'chat-1', ok: true }] })

    const result = await probeLegacyDataWithLocalKeys()

    expect(result.outcome).toBe('decryptable')
    expect(legacyKeyProbeAllowsBinding(result)).toBe(true)
  })

  it('rejects binding when any sampled row has UNKNOWN_KEY', async () => {
    mockPull.mockResolvedValueOnce({
      items: [{ id: 'chat-1', ok: true }],
    })
    mockPull.mockResolvedValueOnce({
      items: [{ id: 'profile', ok: false, code: 'UNKNOWN_KEY' }],
    })
    mockPull.mockResolvedValue({ items: [] })

    const result = await probeLegacyDataWithLocalKeys()

    expect(result.outcome).toBe('undecryptable')
    expect(result.sampledDecryptable).toBe(true)
    expect(legacyKeyProbeAllowsBinding(result)).toBe(false)
  })

  it('distinguishes transient probe failures from key mismatch', async () => {
    mockPull.mockRejectedValue(new Error('network down'))

    const result = await probeLegacyDataWithLocalKeys()

    expect(result.outcome).toBe('transient_failure')
    expect(legacyKeyProbeAllowsBinding(result)).toBe(false)
  })
})
