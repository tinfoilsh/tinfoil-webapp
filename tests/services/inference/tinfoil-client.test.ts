import { getRecoveryBaseURL } from '@/services/inference/tinfoil-client'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/config', () => ({
  API_BASE_URL: 'http://api.example',
}))

describe('tinfoil recovery transport', () => {
  it('rejects an insecure controlplane URL', () => {
    expect(() => getRecoveryBaseURL()).toThrow(
      'Controlplane base URL must use HTTPS',
    )
  })
})
