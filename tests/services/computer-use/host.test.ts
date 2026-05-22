import { isMacOS } from '@/services/computer-use/host'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())

describe('isMacOS', () => {
  it('true for a macOS userAgentData hint', () => {
    vi.stubGlobal('navigator', {
      userAgentData: { platform: 'macOS' },
      userAgent: '',
    })
    expect(isMacOS()).toBe(true)
  })

  it('false for a Windows userAgentData hint', () => {
    vi.stubGlobal('navigator', {
      userAgentData: { platform: 'Windows' },
      userAgent: '',
    })
    expect(isMacOS()).toBe(false)
  })

  it('true for a Mac platform string (no userAgentData)', () => {
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })
    expect(isMacOS()).toBe(true)
  })

  it('false on Windows', () => {
    vi.stubGlobal('navigator', {
      platform: 'Win32',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    })
    expect(isMacOS()).toBe(false)
  })

  it('false on iPadOS even though it reports a Mac-like platform', () => {
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent:
        'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
    })
    expect(isMacOS()).toBe(false)
  })
})
